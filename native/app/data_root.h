// Latch's own folders, its log and its place in the suite (host_stubs.cpp, app_log.cpp, self_register.cpp).
#pragma once
#include <string>

namespace latch {

std::string dataRoot();          // Latch's data folder, '/' separated (settings.json, native_ui.json)
void setWritable(bool on);       // false: settings.json is never written (headless runs)
bool isWritable();
bool writeFileAtomic(const std::string& path, const std::string& text);   // (temp sibling, renamed over)

// This app's own latch CLI: <exe dir>/coredist/latch (the installed layout on both platforms), then beside the exe
// (not on the Mac, where .../MacOS/latch is this GUI, .../MacOS/Latch);
// in a dev run (the exe in a CMake build tree) the repo's own build (build/Release, then build/, build/Debug).
// "" when none is there.
std::string ownCore();
// Shared/registry.json's "latch" entry pointed at `core` (registry.rs register_self: WAVdesk finds this install's CLI
// there); siblings kept, written to a temp file and renamed over. `shared`: that folder instead of the suite's (the
// manager's --setup --test-root); unregisterSelf takes the entry out again (--uninstall), siblings kept
void registerSelf(const std::string& core, const std::string& shared = "");
void unregisterSelf(const std::string& shared = "");

// the manager's install contract (vacant-labs apps/manager/docs/app-contract.md): --setup, the three --uninstall forms,
// --test-root. -1: not such a launch (the app runs); else the process's exit code (0 done, 1 failed, 2 usage). Before
// the window and the one-instance hand-off. Windows only (elsewhere -1)
int setupCli(int argc, wchar_t** argv);

// tools.rs provision_ytdlp / provision_ffmpeg: the installer's bundled yt-dlp.exe into Latch's managed bin
// (%ProgramData%\Vacant Systems\Latch\bin) and ffmpeg.exe + ffprobe.exe into Shared\bin, each only when absent there
// (never over a newer download). From <exe dir>/resources/{ytdlp,ffmpeg}; a build without them (the embedded
// installer, a dev run) leaves the first extract to download them (the window shows that progress). Windows only.
void provisionBundled();

// the yt-dlp / ffmpeg / ffprobe the core runs (paths.cpp resolve_binary): the Settings override (settings.json
// ytdlpPath / ffmpegPath, the Tauri app's keys; ffprobe beside a custom ffmpeg), its LATCH_* variable, beside the
// core, the managed home (Shared/bin, Latch/bin). `source`: override / env / portable / managed / missing ("" path)
std::string toolPath(const std::string& name, std::string* source = nullptr);
std::string toolOverride(const std::string& name);   // (the Settings field, trimmed: "" = auto)
// the overrides as the LATCH_* variables every child core inherits (settings.rs apply_tool_env): at launch and after
// each Settings change
void applyToolEnv();

// the Tauri app's window settings (its webview's localStorage, wd-latch-*) into native_ui.json, once, then its old
// webview profile removed (tauri_import.cpp); and Settings' downloadDir for a window with no folder of its own yet.
// Both before the window is made (it reads them as it is built)
void importTauriState();
void seedDownloadDir();

// logger.rs: <data root>/logs/latch.log, one "[YYYY-MM-DD HH:MM:SSZ] line" per event, appended (also to stderr);
// logInit starts a session (the file dropped past 1 MB). Never written in a headless run (setWritable(false))
std::string logPath();
void logInit();
void log(const std::string& line);

}  // namespace latch
