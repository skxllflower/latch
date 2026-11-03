// Latch's native GUI: the extract window (latch_app.h) on vpf's standalone runner, replacing the Tauri GUI (gui/).
//
//   latch-gui [<url or file> ...]               queued as if typed into the prompt (a URL, a file to chop, a search)
//             [--skin dev|vx|focused|zen-dark]  the look for this run (the window keeps the last one picked)
// and the runner's own flags (--screenshot, --steps, --dump-tree, --size, --scale ...: vacant-labs vpf/CLAUDE.md).
//
// One Latch at a time (Tauri's single-instance plugin, Windows): a second launch hands its arguments to the running
// window (which comes to the front and queues them) and exits before anything opens. The latch CLI does every
// download (latch_window.h: `latch extract`, two at once); this process never downloads anything itself.
#include "about_window.h"
#include "audio_out.h"
#include "chop_engine.h"
#include "latch_chop_window.h"
#include "settings_window.h"
#include "data_root.h"
#include "dev_run.h"
#include "dialog_window.h"
#include "external_tools.h"
#include "latch_app.h"
#include "look.h"
#include "settings_store.h"
#include "skin.h"
#include "ui_state.h"
#include "window_place.h"
#include <cstdlib>
#include <filesystem>
#include <thread>
#include <vpf/gui/editor.h>
#include <vpf/plugin_entry.h>
#include <vpf/preset.h>
#if defined(_WIN32)
#include <cstdio>
#define WIN32_LEAN_AND_MEAN
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <shellapi.h>
#endif

namespace {

using vpf::gui::Editor;

bool headless() { return vpf::hasStandaloneArg("--steps") || vpf::hasStandaloneArg("--screenshot") || vpf::hasStandaloneArg("--dump-tree"); }

#if defined(_WIN32)
// a GUI-subsystem exe (no console window); a run from a terminal (the headless flags, the checks) writes to it instead.
// Redirected handles (a pipe, a file) are inherited as they are and left alone
const bool g_parentConsole = [] {
    const HANDLE out = GetStdHandle(STD_OUTPUT_HANDLE);
    if ((out && out != INVALID_HANDLE_VALUE) || !AttachConsole(ATTACH_PARENT_PROCESS)) return false;
    FILE* f = nullptr;
    freopen_s(&f, "CONOUT$", "w", stdout);
    freopen_s(&f, "CONOUT$", "w", stderr);
    return true;
}();

// ---- one Latch at a time: a named mutex, and a message-only window the second launch sends its arguments to ----
const wchar_t* const kMutex = L"Local\\VacantSystems.Latch.Native";
const wchar_t* const kHandoffClass = L"VacantSystems.Latch.Handoff";
std::function<void(std::vector<std::string>)> g_onLaunch;   // (the UI thread's: set once the window is built)
std::vector<std::vector<std::string>> g_early;               // (launches that came before it)

std::vector<std::string> ownArgs() {
    std::vector<std::string> out;
    int n = 0;
    LPWSTR* w = CommandLineToArgvW(GetCommandLineW(), &n);
    for (int i = 1; w && i < n; ++i) out.push_back(std::filesystem::path(w[i]).u8string());
    if (w) LocalFree(w);
    return out;
}

LRESULT CALLBACK handoffProc(HWND h, UINT msg, WPARAM wp, LPARAM lp) {
    if (msg == WM_COPYDATA) {
        const auto* cd = reinterpret_cast<const COPYDATASTRUCT*>(lp);
        std::vector<std::string> args;
        const std::string all(static_cast<const char*>(cd->lpData), cd->cbData);
        for (size_t a = 0; a <= all.size();) {   // ('\0' between the arguments)
            const size_t b = all.find('\0', a);
            const std::string s = all.substr(a, b == std::string::npos ? std::string::npos : b - a);
            if (!s.empty()) args.push_back(s);
            if (b == std::string::npos) break;
            a = b + 1;
        }
        if (g_onLaunch) g_onLaunch(args); else g_early.push_back(args);
        return TRUE;
    }
    return DefWindowProcW(h, msg, wp, lp);
}

// (before main) false: another Latch has this launch's arguments, and this process exits
const bool g_sole = [] {
    // (the manager's --setup / --uninstall: no hand-off and no mutex, which --uninstall reads as "Latch is running"; they
    // run from latchDef)
    if (latch::setupRequested()) return true;
    // (vpf has not parsed the arguments yet: before main, the command line itself)
    for (const std::string& a : ownArgs()) if (a == "--steps" || a == "--screenshot" || a == "--dump-tree") return true;
    CreateMutexW(nullptr, TRUE, kMutex);
    if (GetLastError() != ERROR_ALREADY_EXISTS) return true;
    for (int tries = 0; tries < 40; ++tries) {   // (the first launch may still be starting: up to 2 s for its window)
        if (HWND to = FindWindowExW(HWND_MESSAGE, nullptr, kHandoffClass, nullptr)) {
            DWORD pid = 0;
            GetWindowThreadProcessId(to, &pid);
            AllowSetForegroundWindow(pid);   // (it may come to the front: this launch is the user's)
            std::string payload;
            for (const std::string& a : ownArgs()) { payload += a; payload += '\0'; }
            COPYDATASTRUCT cd{1, (DWORD)payload.size(), payload.data()};
            DWORD_PTR r = 0;
            SendMessageTimeoutW(to, WM_COPYDATA, 0, (LPARAM)&cd, SMTO_ABORTIFHUNG, 3000, &r);
            std::_Exit(0);
        }
        Sleep(50);
    }
    return true;   // (no window answered: a stale mutex of a hung one; run anyway)
}();

void makeHandoffWindow() {
    WNDCLASSW wc{};
    wc.lpfnWndProc = handoffProc;
    wc.hInstance = GetModuleHandleW(nullptr);
    wc.lpszClassName = kHandoffClass;
    RegisterClassW(&wc);
    CreateWindowExW(0, kHandoffClass, L"", 0, 0, 0, 0, 0, HWND_MESSAGE, nullptr, wc.hInstance, nullptr);
}

// the main window brought to the front (the plugin's unminimize / show / set_focus): this thread's visible top level
void focusMainWindow() {
    EnumThreadWindows(GetCurrentThreadId(), [](HWND h, LPARAM) -> BOOL {
        if (!IsWindowVisible(h) && !IsIconic(h)) return TRUE;
        if (GetWindow(h, GW_OWNER)) return TRUE;   // (a popup's)
        if (IsIconic(h)) ShowWindow(h, SW_RESTORE);
        SetForegroundWindow(h);
        return FALSE;
    }, 0);
}
#endif

// the URLs and files a launch names (not flags, not a flag's value)
std::vector<std::string> fileArgs(const std::vector<std::string>& args) {
    std::vector<std::string> out;
    for (size_t i = 0; i < args.size(); ++i) {
        if (args[i].rfind("--", 0) == 0) { if (args[i] == "--skin" || args[i] == "--size" || args[i] == "--scale" || args[i] == "--screenshot" || args[i] == "--steps" || args[i] == "--dump-tree") ++i; continue; }
        out.push_back(args[i]);
    }
    return out;
}

void applySkin(const std::string& name) {
    wdn::setSkin(wdn::makeSkin(name));
    wdn::look::setTextScale(1.0f);
}

Editor* createEditor(vpf::gui::EditorHost& host) {
    wdn::dev::dropBinaryOverrides();   // (a packaged run: LATCH_EXE and the rest never reach the children)
    const bool quiet = headless();
    latch::setWritable(!quiet);
    latch::logInit();
    latch::provisionBundled();
    latch::applyToolEnv();
    wdn::ui_state::setEnabled(!quiet);   // (the checks start from the defaults and leave nothing behind)
    latch::importTauriState();
    latch::seedDownloadDir();
    wdn::ext::setSharedWritable(!quiet);

    // this app's own CLI: in a dev run through LATCH_EXE (the tiers' env override, dev runs only); installed, through
    // the shared registry it registers into (as the Tauri app did at setup: WAVdesk finds this install there too)
    const std::string core = latch::ownCore();
    if (!core.empty() && wdn::dev::devRun()) {
#if defined(_WIN32)
        if (!_wgetenv(L"LATCH_EXE")) _wputenv_s(L"LATCH_EXE", std::filesystem::u8path(core).wstring().c_str());
#else
        setenv("LATCH_EXE", core.c_str(), 0);
#endif
    } else if (!core.empty()) {
        latch::registerSelf(core);
    }
    latch::log("core: " + (core.empty() ? std::string("(none of its own)") : core));

    auto* ed = new Editor(host, latch::LatchApp::kWidth, latch::LatchApp::kHeight);
    ed->setResizable(latch::LatchApp::kWidth, latch::LatchApp::kHeight);   // (tauri.conf: resizable, never smaller than its first size)
    ed->setCustomFrame(Editor::customFrameSupported());   // (the title strip is the window's: decorations false)
    ed->setCornerStyle(vpf::gui::CornerStyle::Round);
    ed->setExactEdges(true);
    ed->setWindowTitle("Latch");

    std::string skinName = vpf::standaloneArgValue("--skin");
    if (skinName.empty()) skinName = wdn::settings::text("skin", "dev");
    applySkin(skinName);

    auto* app = ed->root().make<latch::LatchApp>();
    app->ownTips = true;   // (no main window to show the parts' tips: ExtWindow rests the pointer itself)
    app->skinName = skinName;
    app->bounds = {0, 0, latch::LatchApp::kWidth, latch::LatchApp::kHeight};
    app->onBoundsChanged();
    ed->onResize = [app](int w, int h) { app->bounds = {0, 0, w, h}; app->onBoundsChanged(); };
    ed->setFocus(app);

    // the one output (audio_out.h): Audition's stream and the chop window's engine take turns on it. It outlives every
    // window: the chop engine is shut down on it first (quit below)
    static std::unique_ptr<latch::AudioOut> out;
    out = std::make_unique<latch::AudioOut>(ed->uiQueue());
    app->setAudio(out.get());
    app->wireHooks(ed->uiQueue());

    // the chop window (WAVdesk's app/mw_latch_chop.cpp): one, a second Chop re-seeds it
    if (!quiet) wdn::LatchChopWindow::sweepStale();
    auto chopWin = std::make_shared<wdn::LatchChopWindow*>(nullptr);
    auto chopOpen = [ed, chopWin] { return *chopWin && ed->isOverlay(*chopWin); };
    auto openChop = [ed, app, chopWin, chopOpen, quiet](const wdn::LatchChopSeed& seed) {
        if (chopOpen()) { ed->raisePopup(*chopWin); (*chopWin)->seed(seed); return; }
        app->stopAudition();   // (the window's sound is the chop engine's)
        auto w = std::make_unique<wdn::LatchChopWindow>(*out);
        wdn::LatchChopWindow* cw = w.get();
        *chopWin = cw;
        cw->synchronous = quiet;
        cw->ownTips = true;
        cw->onClosed = [ed, chopWin, chopOpen] { if (chopOpen()) ed->closePopup(*chopWin); *chopWin = nullptr; };
        cw->onLanded = [app](const std::vector<std::string>& outs) {   // (Tauri's wd-latch-clip-exported: the clips join Outputs)
            for (const std::string& o : outs) { latch::log("chop landed: " + o); app->addOutput(o); }
        };
        cw->clipsFolder = [](const std::string& source) {   // (settings.json clipsDir: a link's clips, as Tauri's chop.rs; a local file's beside it)
            if (!source.empty()) return std::string();
            std::string d = wdn::settings::text("clipsDir", "");
            const size_t a = d.find_first_not_of(" \t\r\n"), b = d.find_last_not_of(" \t\r\n");
            return a == std::string::npos ? std::string() : d.substr(a, b - a + 1);
        };
        cw->onToast = [app](const std::string& t) { latch::log("toast: " + t); app->toast(t); };
        const int W = wdn::LatchChopWindow::kWidth, H = wdn::LatchChopWindow::kHeight;
        cw->bounds = {(app->bounds.w - W) / 2, (app->bounds.h - H) / 2, W, H};
        cw->onBoundsChanged();
        vpf::gui::PopupOptions o;
        o.window = true;
        o.detached = true;
        o.activates = true;
        o.corners = vpf::gui::CornerStyle::Round;
        o.resizeEdge = wdn::look::kWindowEdge;
        o.minW = wdn::LatchChopWindow::kMinWidth;
        o.minH = wdn::LatchChopWindow::kMinHeight;
        wdn::openWindow(*ed, std::move(w), o);
        ed->setFocus(cw);
        cw->seed(seed);
    };
    app->onChop = openChop;
    // (a headless run: LATCH_CHOP=<local file> opens it once the window is up, the screenshots' fixture)
    if (const char* f = std::getenv("LATCH_CHOP"); f && *f && quiet) {
        wdn::LatchChopSeed s;
        s.localFile = f;
        s.includeVideo = wdn::ext::isVideoPath(f);
        s.title = std::filesystem::u8path(f).filename().u8string();
        ed->uiQueue()->post([openChop, s] { openChop(s); });
    }
    // quitting: the chop session let go, then the engine, then the output. On a close the window is still up (it is
    // closed first); in any other teardown (a headless run's end) the editor took the windows before the root, and
    // LatchApp's destructor runs the rest
    auto teardown = std::make_shared<bool>(false);
    auto finish = [app, teardown] {
        if (*teardown) return;
        *teardown = true;
        app->stopAudition();
        wdn::ChopEngine::shutdown();
        app->setAudio(nullptr);
        out.reset();
    };
    app->onTeardown = finish;
    auto quit = [chopWin, chopOpen, finish] {
        if (chopOpen()) { (*chopWin)->onClosed = nullptr; (*chopWin)->onEngineGiven = nullptr; (*chopWin)->closeNow(); }
        *chopWin = nullptr;
        finish();
    };

    // the close (the X, Alt+F4, Cmd+Q): asked first while downloading or updating, as WAVdesk's Latch window asks
    ed->onCloseRequest = [ed, app, quit] {
        if (!app->busy()) { quit(); return true; }
        wdn::askConfirm(*ed, "Stop downloading?", "Closing Latch stops the downloads in progress.", "Stop and Close", [ed, quit] { quit(); ed->closeStandaloneWindow(); });
        return false;
    };
    app->onClose = [ed, quit] { if (ed->closeRequested()) { quit(); ed->closeStandaloneWindow(); } };

    app->onToast = [app](const std::string& t) { latch::log("toast: " + t); app->toast(t); };
    app->onLanded = [](const std::string& out) { latch::log("landed: " + out); };
    app->onAudition = [app](const std::string& path) { app->audition(path); };

    // About and Settings: one window each, raised when open
    auto about = std::make_shared<latch::AboutWindow*>(nullptr);
    auto settings = std::make_shared<latch::SettingsWindow*>(nullptr);
    auto openOne = [ed](auto slot, auto make, int w, int h) {
        if (*slot && wdn::liveWindow(*ed, *slot)) { ed->raisePopup(*slot); return; }
        auto win = make();
        auto* raw = win.get();
        *slot = raw;
        raw->bounds = {(latch::LatchApp::kWidth - w) / 2, 0, w, h};
        raw->onBoundsChanged();
        raw->onClose = [ed, raw, slot] { if (wdn::liveWindow(*ed, raw)) ed->closePopup(raw); *slot = nullptr; };
        vpf::gui::PopupOptions o;
        o.window = true;
        o.detached = true;
        o.activates = true;
        o.corners = vpf::gui::CornerStyle::Round;
        wdn::openWindow(*ed, std::move(win), o);
        ed->setFocus(raw);
    };
    app->onAbout = [openOne, about] {
        openOne(about, [] { return std::make_unique<latch::AboutWindow>(); }, latch::AboutWindow::kWidth, latch::AboutWindow::kHeight);
    };
    app->onSettings = [openOne, settings] {
        openOne(settings, [] {
            auto w = std::make_unique<latch::SettingsWindow>();
            w->onToolsChanged = [] { latch::applyToolEnv(); };
            return w;
        }, latch::SettingsWindow::kWidth, latch::SettingsWindow::kHeight);
    };

    // another look: applied at once, kept in settings.json
    app->onSkin = [app, about, settings, ed](const std::string& name) {
        applySkin(name);
        wdn::settings::set("skin", name);
        app->skinName = name;
        app->onBoundsChanged();
        if (*about && wdn::liveWindow(*ed, *about)) (*about)->onBoundsChanged();
        if (*settings && wdn::liveWindow(*ed, *settings)) (*settings)->onBoundsChanged();
        ed->requestRepaint();
    };

    // the binary's state (tool_binary_probe), off the UI thread
    {
        std::shared_ptr<vpf::gui::UiQueue> q = ed->uiQueue();
        std::thread([q, app, core] {
            wdn::ext::ToolStatus st = wdn::ext::probeTool("latch");
            latch::log("probe latch: " + (st.resolved ? st.source + " " + st.path : "missing: " + st.message));
            // (the window shows "configured" in the ok tone, any other tier as a fallback: this app's own core is no
            // fallback, whichever tier found it)
            if (st.resolved && !core.empty() && std::filesystem::u8path(st.path) == std::filesystem::u8path(core)) st.source = "configured";
            q->post([app, st] { app->setStatus(st); });
        }).detach();
    }

    // what a launch hands over: its URLs and files, queued
    auto takeLaunch = [app](const std::vector<std::string>& args) {
        const std::vector<std::string> items = fileArgs(args);
        latch::log("launch handed over: " + std::to_string(items.size()) + " item(s)");
        app->take(items);
    };
    ed->onOpenFiles = [app](const std::vector<std::string>& paths) { app->take(paths); };   // (the runner's document arguments, the Dock)
#if defined(_WIN32)
    if (!quiet) {
        makeHandoffWindow();
        std::shared_ptr<vpf::gui::UiQueue> q = ed->uiQueue();
        g_onLaunch = [q, takeLaunch](std::vector<std::string> args) {
            q->post([takeLaunch, args] { focusMainWindow(); takeLaunch(args); });
        };
        for (auto& a : g_early) g_onLaunch(a);
        g_early.clear();
    }
#else
    (void)takeLaunch;
#endif
    return ed;
}

// vpf's main asks for the definition first, before it reads a flag or builds anything: the manager's --setup /
// --uninstall (setup_cli.cpp) run there, after every static initializer (never from one: a file's globals may not be
// built yet), with no window; the process exits with its code
const vpf::PluginDef& latchDef() {
#if defined(_WIN32)
    if (latch::setupRequested()) {
        int n = 0;
        LPWSTR* w = CommandLineToArgvW(GetCommandLineW(), &n);
        const int rc = w ? latch::setupCli(n, w) : 1;
        if (w) LocalFree(w);
        std::fflush(stdout);
        std::fflush(stderr);
        std::_Exit(rc < 0 ? 2 : rc);
    }
#endif
    static vpf::PluginDef d = [] {
        vpf::PluginDef p;
        p.info.id = "com.vacantsystems.latch";
        p.info.name = "Latch";
        p.createEditor = &createEditor;
        return p;
    }();
    return d;
}

}  // namespace

VPF_PLUGIN(latchDef)
