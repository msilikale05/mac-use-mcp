import { z } from "zod";
import { readFile, unlink, mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { zodToToolInputSchema } from "../helpers/schema.js";
import { captureScreen } from "../helpers/screencapture.js";
import { runAppleScript } from "../helpers/applescript.js";
import { runInputHelper } from "../helpers/input-helper.js";
import { execFileAsync } from "../helpers/exec.js";
import { DEFAULT_MAX_DIMENSION } from "../constants.js";
import { enqueue } from "../queue.js";
import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";

// -- Constants ---------------------------------------------------------------

const MIN_MAX_DIMENSION = 256;
const MAX_MAX_DIMENSION = 4096;
const DEFAULT_SAVE_DIR = join(homedir(), "Desktop", "screenshots");

// -- Schemas -----------------------------------------------------------------

const ScreenshotFocusedSchema = z.object({
  max_dimension: z
    .number()
    .int()
    .min(0)
    .max(MAX_MAX_DIMENSION)
    .default(0)
    .describe("Maximum width or height. 0 = no resize."),
  format: z
    .enum(["png", "jpeg"])
    .default("png")
    .describe("Output image format."),
  save_path: z
    .string()
    .max(1000)
    .optional()
    .describe(
      "Optional file path to save the screenshot to disk (e.g. '/Users/me/Desktop/screenshots/step_01.png'). If omitted, only returns base64.",
    ),
});

const ScreenshotElementSchema = z.object({
  app: z
    .string()
    .max(1000)
    .describe("Application name (e.g. 'QGIS', 'Safari')."),
  element: z
    .enum(["menu_bar", "toolbar", "dialog", "sheet", "popover", "focused_element"])
    .describe(
      "Which UI element to capture: menu_bar, toolbar, dialog (frontmost dialog/sheet), sheet, popover, or focused_element.",
    ),
  padding: z
    .number()
    .int()
    .min(0)
    .max(100)
    .default(10)
    .describe("Extra padding in pixels around the element (default 10)."),
  max_dimension: z
    .number()
    .int()
    .min(0)
    .max(MAX_MAX_DIMENSION)
    .default(0)
    .describe("Maximum width or height. 0 = no resize."),
  format: z
    .enum(["png", "jpeg"])
    .default("png")
    .describe("Output image format."),
  save_path: z
    .string()
    .max(1000)
    .optional()
    .describe("Optional file path to save the screenshot to disk."),
});

const SaveScreenshotSchema = z.object({
  mode: z
    .enum(["full", "focused", "window"])
    .default("focused")
    .describe("Capture mode: full screen, focused window, or window by title."),
  window_title: z
    .string()
    .max(1000)
    .optional()
    .describe("Window title (required when mode is 'window')."),
  save_dir: z
    .string()
    .max(1000)
    .default(DEFAULT_SAVE_DIR)
    .describe(`Directory to save screenshots. Defaults to ${DEFAULT_SAVE_DIR}.`),
  filename: z
    .string()
    .max(500)
    .describe(
      "Filename for the screenshot (e.g. 'step_01_open_file_menu.png'). Extension determines format.",
    ),
  max_dimension: z
    .number()
    .int()
    .min(0)
    .max(MAX_MAX_DIMENSION)
    .default(0)
    .describe("Maximum width or height. 0 = no resize."),
});

const ScreenshotAppSchema = z.object({
  app: z
    .enum(["screencapture", "cleanshot", "shottr"])
    .default("screencapture")
    .describe(
      "Screenshot app to use: 'screencapture' (built-in macOS), 'cleanshot' (CleanShot X), 'shottr' (Shottr).",
    ),
  mode: z
    .enum(["fullscreen", "window", "area"])
    .default("window")
    .describe("Capture mode."),
  save_path: z
    .string()
    .max(1000)
    .describe("File path to save the screenshot."),
  delay: z
    .number()
    .min(0)
    .max(10)
    .default(0)
    .describe("Delay in seconds before capturing (useful for menus/popups)."),
});

// -- Tool definitions --------------------------------------------------------

export const focusedScreenshotToolDefinitions: Tool[] = [
  {
    name: "screenshot_focused",
    description:
      "Capture a screenshot of ONLY the currently focused/frontmost window. No need to specify a window title — it automatically detects the active window. Ideal for step-by-step documentation. Optionally save to a file path.",
    inputSchema: zodToToolInputSchema(ScreenshotFocusedSchema),
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: "screenshot_element",
    description:
      "Capture a screenshot of a specific UI element (menu bar, toolbar, dialog, sheet, popover, or focused element) in an application. Uses the macOS Accessibility API to find the element bounds, then captures just that region. Perfect for documenting specific parts of an interface.",
    inputSchema: zodToToolInputSchema(ScreenshotElementSchema),
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: "save_screenshot",
    description:
      "Capture and save a screenshot to disk with a descriptive filename. Ideal for building step-by-step tutorial images. Captures the focused window by default. Creates the save directory if it doesn't exist.",
    inputSchema: zodToToolInputSchema(SaveScreenshotSchema),
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "screenshot_with_app",
    description:
      "Take a screenshot using a third-party macOS screenshot app (CleanShot X, Shottr) or the built-in screencapture command. Useful when you need features like window shadows, rounded corners, or specific capture modes not available in the default tool.",
    inputSchema: zodToToolInputSchema(ScreenshotAppSchema),
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
];

// -- Helpers -----------------------------------------------------------------

/** Get the frontmost window title and app via AppleScript. */
async function getFocusedWindowInfo(): Promise<{
  app: string;
  title: string;
}> {
  const script = `
tell application "System Events"
  set frontApp to name of first application process whose frontmost is true
  set frontTitle to ""
  try
    set frontTitle to name of front window of (first application process whose frontmost is true)
  end try
  return frontApp & "|||" & frontTitle
end tell`;

  const result = await runAppleScript(script);
  const parts = result.split("|||");
  return { app: parts[0] || "Unknown", title: parts[1] || "" };
}

/** Get bounds of a UI element via Accessibility API. */
async function getElementBounds(
  app: string,
  element: string,
): Promise<{ x: number; y: number; w: number; h: number } | null> {
  let role: string;
  let searchScript: string;

  switch (element) {
    case "menu_bar":
      searchScript = `
tell application "System Events"
  tell process "${app}"
    set mb to menu bar 1
    set pos to position of mb
    set sz to size of mb
    return (item 1 of pos) & "," & (item 2 of pos) & "," & (item 1 of sz) & "," & (item 2 of sz)
  end tell
end tell`;
      break;
    case "toolbar":
      searchScript = `
tell application "System Events"
  tell process "${app}"
    set tb to toolbar 1 of front window
    set pos to position of tb
    set sz to size of tb
    return (item 1 of pos) & "," & (item 2 of pos) & "," & (item 1 of sz) & "," & (item 2 of sz)
  end tell
end tell`;
      break;
    case "dialog":
    case "sheet":
      searchScript = `
tell application "System Events"
  tell process "${app}"
    set dlg to front window
    -- Try to find a sheet first, then fall back to the window itself
    try
      set dlg to sheet 1 of front window
    end try
    set pos to position of dlg
    set sz to size of dlg
    return (item 1 of pos) & "," & (item 2 of pos) & "," & (item 1 of sz) & "," & (item 2 of sz)
  end tell
end tell`;
      break;
    case "popover":
      searchScript = `
tell application "System Events"
  tell process "${app}"
    set pop to pop over 1 of front window
    set pos to position of pop
    set sz to size of pop
    return (item 1 of pos) & "," & (item 2 of pos) & "," & (item 1 of sz) & "," & (item 2 of sz)
  end tell
end tell`;
      break;
    case "focused_element":
      searchScript = `
tell application "System Events"
  tell process "${app}"
    set fe to focused UI element of front window
    set pos to position of fe
    set sz to size of fe
    return (item 1 of pos) & "," & (item 2 of pos) & "," & (item 1 of sz) & "," & (item 2 of sz)
  end tell
end tell`;
      break;
    default:
      return null;
  }

  try {
    const result = await runAppleScript(searchScript);
    const [x, y, w, h] = result.split(",").map(Number);
    if (isNaN(x) || isNaN(y) || isNaN(w) || isNaN(h)) return null;
    return { x, y, w, h };
  } catch {
    return null;
  }
}

/** Save base64 data to a file path, creating directories as needed. */
async function saveBase64ToFile(
  base64: string,
  filePath: string,
): Promise<void> {
  const dir = filePath.substring(0, filePath.lastIndexOf("/"));
  await mkdir(dir, { recursive: true });
  const buffer = Buffer.from(base64, "base64");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(filePath, buffer);
}

// -- Handlers ----------------------------------------------------------------

async function handleScreenshotFocused(
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const parsed = ScreenshotFocusedSchema.parse(args);

  const { title } = await getFocusedWindowInfo();
  if (!title) {
    return {
      content: [
        {
          type: "text" as const,
          text: "No focused window found. Make sure an application window is in the foreground.",
        },
      ],
      isError: true,
    };
  }

  const result = await captureScreen({
    mode: "window",
    windowTitle: title,
    maxDimension: parsed.max_dimension,
    format: parsed.format,
  });

  const mimeType = parsed.format === "jpeg" ? "image/jpeg" : "image/png";

  // Optionally save to disk
  if (parsed.save_path) {
    await saveBase64ToFile(result.base64, parsed.save_path);
  }

  const content: CallToolResult["content"] = [
    { type: "image" as const, data: result.base64, mimeType },
    {
      type: "text" as const,
      text: `Captured focused window: "${title}" (${result.width}x${result.height})${parsed.save_path ? `\nSaved to: ${parsed.save_path}` : ""}`,
    },
  ];

  return { content };
}

async function handleScreenshotElement(
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const parsed = ScreenshotElementSchema.parse(args);

  const bounds = await getElementBounds(parsed.app, parsed.element);
  if (!bounds) {
    return {
      content: [
        {
          type: "text" as const,
          text: `Could not find ${parsed.element} in ${parsed.app}. Make sure the app is running and the element is visible.`,
        },
      ],
      isError: true,
    };
  }

  // Add padding
  const p = parsed.padding;
  const region = {
    x: bounds.x - p,
    y: bounds.y - p,
    w: bounds.w + p * 2,
    h: bounds.h + p * 2,
  };

  const result = await captureScreen({
    mode: "region",
    region,
    maxDimension: parsed.max_dimension,
    format: parsed.format,
  });

  const mimeType = parsed.format === "jpeg" ? "image/jpeg" : "image/png";

  if (parsed.save_path) {
    await saveBase64ToFile(result.base64, parsed.save_path);
  }

  return {
    content: [
      { type: "image" as const, data: result.base64, mimeType },
      {
        type: "text" as const,
        text: `Captured ${parsed.element} of ${parsed.app} (${result.width}x${result.height})${parsed.save_path ? `\nSaved to: ${parsed.save_path}` : ""}`,
      },
    ],
  };
}

async function handleSaveScreenshot(
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const parsed = SaveScreenshotSchema.parse(args);

  const ext = parsed.filename.split(".").pop()?.toLowerCase();
  const format = ext === "jpeg" || ext === "jpg" ? "jpeg" : "png";
  const filePath = join(parsed.save_dir, parsed.filename);

  let captureOpts: Parameters<typeof captureScreen>[0];

  if (parsed.mode === "focused") {
    const { title } = await getFocusedWindowInfo();
    if (!title) {
      return {
        content: [{ type: "text" as const, text: "No focused window found." }],
        isError: true,
      };
    }
    captureOpts = {
      mode: "window",
      windowTitle: title,
      maxDimension: parsed.max_dimension,
      format,
    };
  } else if (parsed.mode === "window") {
    if (!parsed.window_title) {
      return {
        content: [
          {
            type: "text" as const,
            text: "window_title is required when mode is 'window'.",
          },
        ],
        isError: true,
      };
    }
    captureOpts = {
      mode: "window",
      windowTitle: parsed.window_title,
      maxDimension: parsed.max_dimension,
      format,
    };
  } else {
    captureOpts = {
      mode: "full",
      maxDimension: parsed.max_dimension,
      format,
    };
  }

  const result = await captureScreen(captureOpts);
  await saveBase64ToFile(result.base64, filePath);

  const mimeType = format === "jpeg" ? "image/jpeg" : "image/png";

  return {
    content: [
      { type: "image" as const, data: result.base64, mimeType },
      {
        type: "text" as const,
        text: `Screenshot saved: ${filePath} (${result.width}x${result.height})`,
      },
    ],
  };
}

async function handleScreenshotWithApp(
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const parsed = ScreenshotAppSchema.parse(args);

  // Ensure save directory exists
  const dir = parsed.save_path.substring(0, parsed.save_path.lastIndexOf("/"));
  await mkdir(dir, { recursive: true });

  try {
    if (parsed.app === "screencapture") {
      // macOS built-in screencapture command
      const cmdArgs: string[] = [];

      if (parsed.mode === "window") {
        cmdArgs.push("-l");
        // Get the frontmost window ID
        const windowId = await runAppleScript(`
tell application "System Events"
  set frontProc to first application process whose frontmost is true
  set frontWin to front window of frontProc
  return id of frontWin
end tell`);
        cmdArgs.push(windowId.trim());
      } else if (parsed.mode === "area") {
        cmdArgs.push("-i", "-s"); // interactive selection
      }
      // fullscreen = no extra flags

      if (parsed.delay > 0) {
        cmdArgs.push("-T", String(parsed.delay));
      }

      cmdArgs.push("-x"); // no sound
      cmdArgs.push(parsed.save_path);

      await execFileAsync("screencapture", cmdArgs, { timeout: 15000 });
    } else if (parsed.app === "cleanshot") {
      // CleanShot X via URL scheme
      let action: string;
      if (parsed.mode === "window") action = "capture-window";
      else if (parsed.mode === "area") action = "capture-area";
      else action = "capture-fullscreen";

      await execFileAsync("open", [
        `cleanshot://api/${action}?filepath=${encodeURIComponent(parsed.save_path)}`,
      ]);

      // Wait for CleanShot to process
      await new Promise((r) => setTimeout(r, (parsed.delay + 2) * 1000));
    } else if (parsed.app === "shottr") {
      // Shottr via CLI or URL scheme
      if (parsed.mode === "window") {
        await execFileAsync("open", [
          `shottr://grab/window?path=${encodeURIComponent(parsed.save_path)}`,
        ]);
      } else if (parsed.mode === "area") {
        await execFileAsync("open", [
          `shottr://grab/area?path=${encodeURIComponent(parsed.save_path)}`,
        ]);
      } else {
        await execFileAsync("open", [
          `shottr://grab/fullscreen?path=${encodeURIComponent(parsed.save_path)}`,
        ]);
      }

      await new Promise((r) => setTimeout(r, (parsed.delay + 2) * 1000));
    }

    // Read the saved file and return as base64
    const buffer = await readFile(parsed.save_path);
    const base64 = buffer.toString("base64");
    const ext = parsed.save_path.split(".").pop()?.toLowerCase();
    const mimeType =
      ext === "jpeg" || ext === "jpg" ? "image/jpeg" : "image/png";

    return {
      content: [
        { type: "image" as const, data: base64, mimeType },
        {
          type: "text" as const,
          text: `Screenshot saved via ${parsed.app}: ${parsed.save_path}`,
        },
      ],
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [
        {
          type: "text" as const,
          text: `Screenshot with ${parsed.app} failed: ${message}`,
        },
      ],
      isError: true,
    };
  }
}

// -- Dispatcher --------------------------------------------------------------

export const focusedScreenshotToolHandlers: Record<
  string,
  (args: Record<string, unknown>) => Promise<CallToolResult>
> = {
  screenshot_focused: (args) => enqueue(() => handleScreenshotFocused(args)),
  screenshot_element: (args) => enqueue(() => handleScreenshotElement(args)),
  save_screenshot: (args) => enqueue(() => handleSaveScreenshot(args)),
  screenshot_with_app: (args) => enqueue(() => handleScreenshotWithApp(args)),
};
