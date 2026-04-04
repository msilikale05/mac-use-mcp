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

/** Base directory for all project screenshot folders. */
const SCREENSHOTS_BASE = join(homedir(), "Desktop", "screenshots");

/**
 * Get the project-specific screenshot directory.
 *
 * Uses the current working directory name as the project name.
 * For example, if Claude Code is running in /Users/me/Projects/flood-research,
 * screenshots go to ~/Desktop/screenshots/flood-research/
 *
 * This keeps screenshots organized per project automatically.
 */
function getProjectScreenshotDir(): string {
  const cwd = process.cwd();
  const projectName = cwd.split("/").pop() || "default";
  return join(SCREENSHOTS_BASE, projectName);
}

/** Auto-generate a timestamped filename for screenshots. */
function autoFilename(prefix: string, format: string): string {
  const now = new Date();
  const ts = now.toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
  return `${prefix}_${ts}.${format}`;
}

// -- Schemas -----------------------------------------------------------------

const ScreenshotFocusedSchema = z.object({
  app: z
    .string()
    .max(1000)
    .optional()
    .describe(
      "Application to screenshot (e.g. 'QGIS', 'Safari'). The app will be focused for the screenshot then focus returns to terminal. If omitted, captures whatever is currently focused.",
    ),
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
      "Optional file path to save the screenshot to disk. If omitted, auto-saves to ~/Desktop/screenshots/<project-name>/ with a timestamped filename.",
    ),
  auto_save: z
    .boolean()
    .default(true)
    .describe(
      "When true (default), automatically saves to the project screenshot folder (~/Desktop/screenshots/<project-name>/). Set to false to only return base64 without saving.",
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
  app: z
    .string()
    .max(1000)
    .optional()
    .describe(
      "Application to screenshot. It will be focused, captured, then focus returns to terminal. If omitted with mode 'focused', captures whatever is currently focused.",
    ),
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
    .optional()
    .describe("Directory to save screenshots. Defaults to ~/Desktop/screenshots/<project-name>/."),
  filename: z
    .string()
    .max(500)
    .optional()
    .describe(
      "Filename for the screenshot (e.g. 'step_01_open_file_menu.png'). If omitted, auto-generates a timestamped name.",
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

const SetProjectSchema = z.object({
  project_name: z
    .string()
    .max(200)
    .optional()
    .describe(
      "Override the project name for screenshot folders. If omitted, resets to auto-detect from the current working directory.",
    ),
  base_dir: z
    .string()
    .max(1000)
    .optional()
    .describe(
      "Override the base directory for screenshots. Defaults to ~/Desktop/screenshots/.",
    ),
});

// -- Project state (overridable per session) ----------------------------------

let _projectNameOverride: string | null = null;
let _baseDirOverride: string | null = null;

/** Get the active screenshot directory, respecting overrides. */
function getActiveScreenshotDir(): string {
  const base = _baseDirOverride || SCREENSHOTS_BASE;
  const project = _projectNameOverride || process.cwd().split("/").pop() || "default";
  return join(base, project);
}

// -- Tool definitions --------------------------------------------------------

export const focusedScreenshotToolDefinitions: Tool[] = [
  {
    name: "screenshot_focused",
    description:
      "Capture a screenshot of a specific app's window. Specify the app name and it will: (1) focus the app, (2) capture its window, (3) return focus to the terminal so you can see progress. If no app is specified, captures whatever is currently focused. Ideal for step-by-step documentation.",
    inputSchema: zodToToolInputSchema(ScreenshotFocusedSchema),
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: "screenshot_element",
    description:
      "Capture a screenshot of a specific UI element (menu bar, toolbar, dialog, sheet, popover, or focused element) in an application. Focuses the app, captures the element region, then returns focus to the terminal. Uses the macOS Accessibility API to find element bounds.",
    inputSchema: zodToToolInputSchema(ScreenshotElementSchema),
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: "save_screenshot",
    description:
      "Capture and save a screenshot to disk with a descriptive filename. Specify an app to focus it, capture, then return to terminal. Ideal for building step-by-step tutorial images. Creates the save directory if it doesn't exist.",
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
  {
    name: "set_screenshot_project",
    description:
      "Set the project name and/or base directory for organizing screenshots. Screenshots are auto-saved to ~/Desktop/screenshots/<project-name>/. By default, the project name is detected from the current working directory. Use this tool to override it for the session.",
    inputSchema: zodToToolInputSchema(SetProjectSchema),
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "get_screenshot_info",
    description:
      "Show the current screenshot settings: project name, save directory, and number of screenshots already taken in this project folder.",
    inputSchema: zodToToolInputSchema(z.object({})),
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
];

// -- Helpers -----------------------------------------------------------------

/** Get the frontmost application name via AppleScript. */
async function getFrontmostApp(): Promise<string> {
  const script = `
tell application "System Events"
  return name of first application process whose frontmost is true
end tell`;
  const result = await runAppleScript(script);
  return result.trim();
}

/**
 * Resolve a user-friendly app name (e.g. "QGIS") to the actual process name
 * that macOS knows (e.g. "QGIS-master-2a28365" or "QGIS-4").
 * Uses fuzzy matching via System Events.
 */
async function resolveProcessName(appName: string): Promise<string> {
  const safeApp = appName.replace(/"/g, '\\"').toLowerCase();
  const script = `
tell application "System Events"
  set matchedApp to ""
  repeat with proc in (every application process whose background only is false)
    set procName to name of proc
    if procName is "${safeApp}" then
      return procName
    end if
    if (procName as text) starts with "${safeApp}" then
      set matchedApp to procName as text
    end if
  end repeat
  if matchedApp is not "" then
    return matchedApp
  end if
  -- Try case-insensitive contains as last resort
  repeat with proc in (every application process whose background only is false)
    set procName to name of proc as text
    considering case
      if procName contains "${appName}" then
        return procName
      end if
    end considering
  end repeat
  return "${appName}"
end tell`;
  const result = await runAppleScript(script);
  return result.trim();
}

/** Focus an application and wait for it to come to front. */
async function focusApp(appName: string): Promise<void> {
  const processName = await resolveProcessName(appName);
  const safeApp = processName.replace(/"/g, '\\"');
  await runAppleScript(`
tell application "System Events"
  set frontmost of process "${safeApp}" to true
end tell
delay 0.5`);
}

/**
 * Focus-capture-return pattern:
 * 1. Remember the current frontmost app (terminal/Warp)
 * 2. Focus the target app
 * 3. Run the capture callback
 * 4. Return focus to the original app
 *
 * This ensures the target app is only in focus during the screenshot,
 * then the terminal comes back so you can see progress.
 */
async function focusAndCapture<T>(
  targetApp: string,
  captureFn: () => Promise<T>,
): Promise<T> {
  // 1. Remember where we are (terminal/Warp)
  const previousApp = await getFrontmostApp();

  // 2. Focus the target app
  await focusApp(targetApp);

  try {
    // 3. Take the screenshot
    const result = await captureFn();
    return result;
  } finally {
    // 4. Always return to the previous app (terminal/Warp)
    await focusApp(previousApp);
  }
}

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

/** Get the window title for a specific app (without changing focus). */
async function getWindowTitleForApp(appName: string): Promise<string> {
  const processName = await resolveProcessName(appName);
  const safeApp = processName.replace(/"/g, '\\"');
  const script = `
tell application "System Events"
  try
    return name of front window of process "${safeApp}"
  on error
    return ""
  end try
end tell`;
  const result = await runAppleScript(script);
  return result.trim();
}

/** Get bounds of a UI element via Accessibility API. */
async function getElementBounds(
  app: string,
  element: string,
): Promise<{ x: number; y: number; w: number; h: number } | null> {
  const processName = await resolveProcessName(app);
  let searchScript: string;

  switch (element) {
    case "menu_bar":
      searchScript = `
tell application "System Events"
  tell process "${processName}"
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
  tell process "${processName}"
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
  tell process "${processName}"
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
  tell process "${processName}"
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
  tell process "${processName}"
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

  const doCapture = async () => {
    // Get the window title of the now-focused app
    const { title } = await getFocusedWindowInfo();
    if (!title) {
      throw new Error("No focused window found. Make sure the application has a visible window.");
    }

    const result = await captureScreen({
      mode: "window",
      windowTitle: title,
      maxDimension: parsed.max_dimension,
      format: parsed.format,
    });

    return { result, title };
  };

  try {
    // If an app is specified, use focus-capture-return pattern
    const { result, title } = parsed.app
      ? await focusAndCapture(parsed.app, doCapture)
      : await doCapture();

    const mimeType = parsed.format === "jpeg" ? "image/jpeg" : "image/png";

    // Determine save path: explicit > auto-save to project dir > none
    let savePath = parsed.save_path;
    if (!savePath && parsed.auto_save) {
      const dir = getActiveScreenshotDir();
      savePath = join(dir, autoFilename("screenshot", parsed.format));
    }

    if (savePath) {
      await saveBase64ToFile(result.base64, savePath);
    }

    return {
      content: [
        { type: "image" as const, data: result.base64, mimeType },
        {
          type: "text" as const,
          text: `Captured window: "${title}" (${result.width}x${result.height})${savePath ? `\nSaved to: ${savePath}` : ""}`,
        },
      ],
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text" as const, text: `Screenshot failed: ${message}` }],
      isError: true,
    };
  }
}

async function handleScreenshotElement(
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const parsed = ScreenshotElementSchema.parse(args);

  const doCapture = async () => {
    const bounds = await getElementBounds(parsed.app, parsed.element);
    if (!bounds) {
      throw new Error(
        `Could not find ${parsed.element} in ${parsed.app}. Make sure the app is running and the element is visible.`,
      );
    }

    const p = parsed.padding;
    const region = {
      x: bounds.x - p,
      y: bounds.y - p,
      w: bounds.w + p * 2,
      h: bounds.h + p * 2,
    };

    return captureScreen({
      mode: "region",
      region,
      maxDimension: parsed.max_dimension,
      format: parsed.format,
    });
  };

  try {
    // Always use focus-capture-return for element screenshots
    const result = await focusAndCapture(parsed.app, doCapture);

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
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text" as const, text: `Screenshot failed: ${message}` }],
      isError: true,
    };
  }
}

async function handleSaveScreenshot(
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const parsed = SaveScreenshotSchema.parse(args);

  const saveDir = parsed.save_dir || getActiveScreenshotDir();
  const filename = parsed.filename || autoFilename("screenshot", "png");
  const ext = filename.split(".").pop()?.toLowerCase();
  const format = ext === "jpeg" || ext === "jpg" ? "jpeg" : "png";
  const filePath = join(saveDir, filename);

  const doCapture = async () => {
    let captureOpts: Parameters<typeof captureScreen>[0];

    if (parsed.mode === "focused") {
      const { title } = await getFocusedWindowInfo();
      if (!title) {
        throw new Error("No focused window found.");
      }
      captureOpts = {
        mode: "window",
        windowTitle: title,
        maxDimension: parsed.max_dimension,
        format,
      };
    } else if (parsed.mode === "window") {
      if (!parsed.window_title) {
        throw new Error("window_title is required when mode is 'window'.");
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

    return captureScreen(captureOpts);
  };

  try {
    // If an app is specified, use focus-capture-return pattern
    const result = parsed.app
      ? await focusAndCapture(parsed.app, doCapture)
      : await doCapture();

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
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text" as const, text: `Screenshot failed: ${message}` }],
      isError: true,
    };
  }
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

async function handleSetProject(
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const parsed = SetProjectSchema.parse(args);

  _projectNameOverride = parsed.project_name || null;
  _baseDirOverride = parsed.base_dir || null;

  const activeDir = getActiveScreenshotDir();

  // Create the directory now so it's ready
  await mkdir(activeDir, { recursive: true });

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            success: true,
            project_name: _projectNameOverride || `(auto: ${process.cwd().split("/").pop()})`,
            screenshot_dir: activeDir,
          },
          null,
          2,
        ),
      },
    ],
  };
}

async function handleGetScreenshotInfo(
  _args: Record<string, unknown>,
): Promise<CallToolResult> {
  const activeDir = getActiveScreenshotDir();
  const projectName = _projectNameOverride || process.cwd().split("/").pop() || "default";

  // Count existing screenshots in the project folder
  let fileCount = 0;
  try {
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(activeDir);
    fileCount = files.filter(
      (f) => f.endsWith(".png") || f.endsWith(".jpeg") || f.endsWith(".jpg"),
    ).length;
  } catch {
    // Directory doesn't exist yet
  }

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            project_name: projectName,
            auto_detected: !_projectNameOverride,
            working_directory: process.cwd(),
            screenshot_dir: activeDir,
            base_dir: _baseDirOverride || SCREENSHOTS_BASE,
            screenshots_taken: fileCount,
          },
          null,
          2,
        ),
      },
    ],
  };
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
  set_screenshot_project: (args) => enqueue(() => handleSetProject(args)),
  get_screenshot_info: (args) => enqueue(() => handleGetScreenshotInfo(args)),
};
