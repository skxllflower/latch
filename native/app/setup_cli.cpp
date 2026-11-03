// The manager's install contract (vacant-labs apps/manager/docs/app-contract.md, sections 3 to 5): what
// native/installer/latch.nsi's Install and Uninstall sections do, from the app itself, so Vacant Systems Manager can
// install Latch from a zip. Keep the two in step (same keys, same values, same folders).
//
//   latch-gui --setup [--test-root R]                          after the manager swaps the folder in (elevated, quiet)
//   latch-gui --uninstall --quiet --keep-files [--test-root R] the manager's remove: what --setup made, not the folder
//   latch-gui --uninstall [--quiet]                            Windows' installed apps: the installer's uninstall
//
// --test-root R touches nothing real: the entry under HKCU\Software\Vacant Systems\Manager Test\Apps\Latch, the
// shortcuts under R\StartMenu and R\Desktop, R\ProgramData for %ProgramData% (its Shared\registry.json included), no
// vacantsystems key, no icacls, no ie4uinit (native/tests/setup/check_setup.py: nothing outside the test root changes).
// Runs from main (main.cpp latchDef), never from a static initializer; the hand-off to a running Latch stands aside.
#include "data_root.h"
#if defined(_WIN32)
#define WIN32_LEAN_AND_MEAN
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <shellapi.h>
#include <shlobj.h>
#include <shobjidl.h>
#include <cstdio>
#include <cwchar>
#include <filesystem>
#include <string>
#include <vector>

namespace fs = std::filesystem;

namespace latch {

namespace {

// (latch.nsi's defines. Every name a compile-time constant, never a std::wstring global: WAVdesk once ran its setup from
// a static initializer before its string key globals were built, and the empty keys opened the HKLM root itself)
const wchar_t* const kProduct = L"Latch";
const wchar_t* const kExe = L"latch-gui.exe";
const wchar_t* const kUninstKey = L"Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Latch";
const wchar_t* const kDirKey = L"Software\\vacantsystems\\Latch";
const wchar_t* const kTestKey = L"Software\\Vacant Systems\\Manager Test\\Apps\\Latch";
const wchar_t* const kDirKeyParent = L"Software\\vacantsystems";
const wchar_t* const kMutex = L"Local\\VacantSystems.Latch.Native";   // (main.cpp's: a running Latch holds it)

struct Where {
    fs::path root;   // (--test-root; empty = the real system)
    fs::path exe, dir;
    bool test() const { return !root.empty(); }
    fs::path programData() const {
        if (test()) return root / "ProgramData";
        wchar_t b[MAX_PATH];
        const DWORD n = GetEnvironmentVariableW(L"ProgramData", b, MAX_PATH);
        return n && n < MAX_PATH ? fs::path(b) : fs::path();
    }
    fs::path startMenu() const;
    fs::path desktop() const;
    HKEY hive() const { return test() ? HKEY_CURRENT_USER : HKEY_LOCAL_MACHINE; }
    const wchar_t* entryKey() const { return test() ? kTestKey : kUninstKey; }
};

fs::path known(REFKNOWNFOLDERID id) {
    PWSTR p = nullptr;
    fs::path out;
    if (SUCCEEDED(SHGetKnownFolderPath(id, 0, nullptr, &p))) out = p;
    CoTaskMemFree(p);
    return out;
}

// the installer's SetShellVarContext all: the common Start menu and the public desktop
fs::path Where::startMenu() const { return test() ? root / "StartMenu" : known(FOLDERID_CommonPrograms) / "Vacant Systems"; }
fs::path Where::desktop() const { return test() ? root / "Desktop" : known(FOLDERID_PublicDesktop); }

void fail(const std::string& why) { std::fprintf(stderr, "latch: %s\n", why.c_str()); std::fflush(stderr); }

bool setString(HKEY k, const wchar_t* name, const std::wstring& v) {
    return RegSetValueExW(k, name, 0, REG_SZ, (const BYTE*)v.c_str(), (DWORD)((v.size() + 1) * sizeof(wchar_t))) == ERROR_SUCCESS;
}
bool setDword(HKEY k, const wchar_t* name, DWORD v) {
    return RegSetValueExW(k, name, 0, REG_DWORD, (const BYTE*)&v, sizeof v) == ERROR_SUCCESS;
}

// a sub-key path that names a key under the hive, never the hive itself ("" or a leading backslash opens the root)
bool underHive(const wchar_t* sub) { return sub && std::wcslen(sub) > 9 && sub[0] != L'\\' && std::wcschr(sub, L'\\'); }

HKEY createKey(HKEY hive, const wchar_t* sub, REGSAM view) {
    if (!underHive(sub)) { fail("refused to write a registry key that names no key under the hive"); return nullptr; }
    HKEY k = nullptr;
    return RegCreateKeyExW(hive, sub, 0, nullptr, 0, KEY_WRITE | view, nullptr, &k, nullptr) == ERROR_SUCCESS ? k : nullptr;
}

// the key itself (RegDeleteKeyEx: only when it has no subkeys left); ERROR_SUCCESS or why not
LSTATUS deleteKey(HKEY hive, const wchar_t* sub, REGSAM view) {
    if (!underHive(sub)) { fail("refused to delete a registry key that names no key under the hive"); return ERROR_INVALID_PARAMETER; }
    return RegDeleteKeyExW(hive, sub, view, 0);
}

std::wstring widen(const std::string& s) {
    const int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), nullptr, 0);
    std::wstring w((size_t)n, L'\0');
    MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), w.data(), n);
    return w;
}

// a hidden child, waited for (icacls, ie4uinit)
void runHidden(std::wstring cmd) {
    STARTUPINFOW si{sizeof si};
    PROCESS_INFORMATION pi{};
    if (!CreateProcessW(nullptr, cmd.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr, nullptr, &si, &pi)) return;
    WaitForSingleObject(pi.hProcess, 60000);
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
}

// the installer's CreateShortcut, made anew so Explorer re-reads the icon
bool shortcut(const fs::path& at, const fs::path& target) {
    std::error_code ec;
    fs::remove(at, ec);
    fs::create_directories(at.parent_path(), ec);
    const HRESULT ci = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    bool ok = false;
    IShellLinkW* link = nullptr;
    if (SUCCEEDED(CoCreateInstance(CLSID_ShellLink, nullptr, CLSCTX_INPROC_SERVER, IID_IShellLinkW, (void**)&link))) {
        link->SetPath(target.c_str());
        link->SetWorkingDirectory(target.parent_path().c_str());
        link->SetIconLocation(target.c_str(), 0);
        IPersistFile* file = nullptr;
        if (SUCCEEDED(link->QueryInterface(IID_IPersistFile, (void**)&file))) {
            ok = SUCCEEDED(file->Save(at.c_str(), TRUE));
            file->Release();
        }
        link->Release();
    }
    if (SUCCEEDED(ci)) CoUninitialize();
    return ok;
}

uint64_t folderBytes(const fs::path& d) {
    uint64_t n = 0;
    std::error_code ec;
    for (auto it = fs::recursive_directory_iterator(d, ec); !ec && it != fs::recursive_directory_iterator(); it.increment(ec))
        if (it->is_regular_file(ec)) n += it->file_size(ec);
    return n;
}

// a recursive delete only of a non-empty path ending in `suffix` (the installer's SAFE_RMDIR_R)
void safeRemoveAll(const fs::path& p, const std::wstring& suffix) {
    const std::wstring s = p.wstring();
    if (s.empty() || s.size() < suffix.size() || _wcsicmp(s.c_str() + s.size() - suffix.size(), suffix.c_str()) != 0) return;
    std::error_code ec;
    fs::remove_all(p, ec);
}

bool latchRunning() {
    if (HANDLE m = OpenMutexW(SYNCHRONIZE, FALSE, kMutex)) { CloseHandle(m); return true; }
    return false;
}

// the installer's WAIT_UNLOCKED on coredist\latch.exe: a download (Latch's, or WAVdesk's) holds it open
bool coreBusy(const Where& w) {
    const fs::path core = w.dir / "coredist" / "latch.exe";
    std::error_code ec;
    if (!fs::exists(core, ec)) return false;
    HANDLE h = CreateFileW(core.c_str(), GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, 0, nullptr);
    if (h == INVALID_HANDLE_VALUE) return GetLastError() == ERROR_SHARING_VIOLATION;
    CloseHandle(h);
    return false;
}

// ---- --setup: the installer's Install section after File ----
int setup(const Where& w) {
    std::error_code ec;
    const fs::path pd = w.programData();
    if (!pd.empty()) {
        fs::create_directories(pd / "Vacant Systems" / "Shared", ec);
        fs::create_directories(pd / "Vacant Systems" / "Latch" / "bin", ec);
        if (!w.test()) {   // (BUILTIN\Users by SID, inherited, Modify: the unelevated app writes its tools there)
            runHidden(L"icacls \"" + (pd / "Vacant Systems" / "Shared").wstring() + L"\" /grant *S-1-5-32-545:(OI)(CI)M /T /Q");
            runHidden(L"icacls \"" + (pd / "Vacant Systems" / "Latch").wstring() + L"\" /grant *S-1-5-32-545:(OI)(CI)M /T /Q");
        }
    }
    const std::wstring lnk = std::wstring(kProduct) + L".lnk";
    if (!shortcut(w.startMenu() / lnk, w.exe)) { fail("cannot make the Start menu shortcut"); return 1; }
    if (!shortcut(w.desktop() / lnk, w.exe)) { fail("cannot make the desktop shortcut"); return 1; }

    const REGSAM view = w.test() ? 0 : KEY_WOW64_64KEY;   // (the installer's SetRegView 64)
    HKEY k = nullptr;
    if (!w.test()) {
        if (!(k = createKey(HKEY_LOCAL_MACHINE, kDirKey, view))) {
            fail("cannot write HKLM\\Software\\vacantsystems\\Latch (not elevated?)");
            return 1;
        }
        setString(k, nullptr, w.dir.wstring());
        RegCloseKey(k);
    }
    if (!(k = createKey(w.hive(), w.entryKey(), view))) {
        fail("cannot write the uninstall entry (not elevated?)");
        return 1;
    }
    const std::wstring qexe = L"\"" + w.exe.wstring() + L"\"";
    const bool ok = setString(k, L"DisplayName", kProduct) && setString(k, L"DisplayIcon", qexe)
                    && setString(k, L"DisplayVersion", widen(LATCH_VERSION)) && setString(k, L"Publisher", L"Vacant Systems")
                    && setString(k, L"InstallLocation", L"\"" + w.dir.wstring() + L"\"")
                    && setString(k, L"UninstallString", qexe + L" --uninstall")
                    && setString(k, L"QuietUninstallString", qexe + L" --uninstall --quiet")
                    && setString(k, L"MainBinaryName", kExe) && setDword(k, L"NoModify", 1) && setDword(k, L"NoRepair", 1)
                    && setDword(k, L"EstimatedSize", (DWORD)(folderBytes(w.dir) / 1024));
    RegCloseKey(k);
    if (!ok) { fail("cannot write the uninstall entry's values"); return 1; }

    // the CLI WAVdesk finds through Shared\registry.json, before Latch's first launch
    const fs::path core = w.dir / "coredist" / "latch.exe";
    if (fs::exists(core, ec) && !pd.empty()) registerSelf(core.generic_u8string(), (pd / "Vacant Systems" / "Shared").generic_u8string());

    if (!w.test()) {
        runHidden(L"ie4uinit.exe -show");
        SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, nullptr, nullptr);
    }
    return 0;
}

// ---- what --setup made, taken out (every --uninstall form) ----
bool unsetup(const Where& w) {
    std::error_code ec;
    const std::wstring lnk = std::wstring(kProduct) + L".lnk";
    fs::remove(w.startMenu() / lnk, ec);
    if (!w.test()) fs::remove(w.startMenu(), ec);   // (RMDir: only when empty)
    fs::remove(w.desktop() / lnk, ec);
    const REGSAM view = w.test() ? 0 : KEY_WOW64_64KEY;
    bool ok = true;
    auto drop = [&](HKEY hive, const wchar_t* key) {
        const LSTATUS r = deleteKey(hive, key, view);
        if (r != ERROR_SUCCESS && r != ERROR_FILE_NOT_FOUND) ok = false;
    };
    drop(w.hive(), w.entryKey());
    if (!w.test()) {
        drop(HKEY_LOCAL_MACHINE, kDirKey);
        deleteKey(HKEY_LOCAL_MACHINE, kDirKeyParent, view);   // (only when empty: no subkeys left)
    }
    const fs::path pd = w.programData();
    if (!pd.empty()) unregisterSelf((pd / "Vacant Systems" / "Shared").generic_u8string());
    if (!w.test()) SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, nullptr, nullptr);
    if (!ok) fail("cannot remove the uninstall entry (not elevated?)");
    return ok;
}

bool elevated() {
    HANDLE t = nullptr;
    TOKEN_ELEVATION e{};
    DWORD n = 0;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &t)) return false;
    const bool ok = GetTokenInformation(t, TokenElevation, &e, sizeof e, &n) && e.TokenIsElevated;
    CloseHandle(t);
    return ok;
}

// the same launch again, as administrator (UAC), waited for: its exit code, or 1
int relaunchElevated(const Where& w, const std::wstring& params) {
    SHELLEXECUTEINFOW se{sizeof se};
    se.fMask = SEE_MASK_NOCLOSEPROCESS;
    se.lpVerb = L"runas";
    se.lpFile = w.exe.c_str();
    se.lpParameters = params.c_str();
    se.nShow = SW_HIDE;
    if (!ShellExecuteExW(&se) || !se.hProcess) return 1;
    WaitForSingleObject(se.hProcess, INFINITE);
    DWORD code = 1;
    GetExitCodeProcess(se.hProcess, &code);
    CloseHandle(se.hProcess);
    return (int)code;
}

// the folder removed once this process has gone (the manager's setup.cpp removeAfterExit: a detached cmd that waits)
void removeAfterExit(const fs::path& dir) {
    const std::wstring d = dir.wstring();
    if (d.size() < 7 || _wcsicmp(d.c_str() + d.size() - 6, L"\\Latch") != 0) return;   // (only Latch's own folder)
    std::wstring cmd = L"cmd.exe /c ping -n 4 127.0.0.1 >nul & rmdir /s /q \"" + d + L"\"";
    wchar_t tmp[MAX_PATH];
    GetTempPathW(MAX_PATH, tmp);
    STARTUPINFOW si{sizeof si};
    PROCESS_INFORMATION pi{};
    if (CreateProcessW(nullptr, cmd.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW | DETACHED_PROCESS, nullptr, tmp, &si, &pi)) {
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
    }
}

// ---- --uninstall [--quiet]: the installer's Uninstall section, in the app ----
int uninstallFull(const Where& w, bool quiet, const std::wstring& params) {
    if (!elevated()) return relaunchElevated(w, params);
    const wchar_t* title = L"Uninstall Latch";
    while (latchRunning() || coreBusy(w)) {
        if (quiet) { fail("Latch is running"); return 1; }
        if (MessageBoxW(nullptr, L"Latch (or a download through it) is running. Quit it, then click Retry.", title,
                        MB_RETRYCANCEL | MB_ICONEXCLAMATION) != IDRETRY) return 1;
    }
    bool deleteData = false;
    if (!quiet) {
        const int a = MessageBoxW(nullptr,
            L"Remove Latch from this computer?\n\nYour downloads and clips are never touched. Also delete Latch's settings and "
            L"log? (No keeps them for a later install.)", title, MB_YESNOCANCEL | MB_ICONQUESTION | MB_DEFBUTTON2);
        if (a == IDCANCEL) return 1;
        deleteData = a == IDYES;
    }
    if (!unsetup(w)) return 1;

    // the last Vacant Systems app out takes the suite's Shared folders with it (only when the user is asked: --quiet
    // keeps Shared, as the contract's quiet form)
    std::error_code ec;
    const fs::path pf = known(FOLDERID_ProgramFiles) / "Vacant Systems";
    const bool last = !fs::exists(pf / "WAVdesk" / "wavdesk.exe", ec) && !fs::exists(pf / "Lathe" / "lathe-gui.exe", ec);
    const fs::path pd = w.programData();
    if (!pd.empty()) {
        safeRemoveAll(pd / "Vacant Systems" / "Latch", L"\\Vacant Systems\\Latch");   // (its managed yt-dlp)
        if (last && !quiet) safeRemoveAll(pd / "Vacant Systems" / "Shared", L"\\Vacant Systems\\Shared");
        fs::remove(pd / "Vacant Systems", ec);
    }
    const fs::path local = known(FOLDERID_LocalAppData);
    if (!local.empty()) {
        safeRemoveAll(local / "com.vacantsystems.latch", L"\\com.vacantsystems.latch");   // (a Tauri profile never imported)
        if (deleteData) {
            safeRemoveAll(local / "Vacant Systems" / "Latch", L"\\Vacant Systems\\Latch");
            if (last) safeRemoveAll(local / "Vacant Systems" / "Shared", L"\\Vacant Systems\\Shared");
            fs::remove(local / "Vacant Systems", ec);
        }
    }
    removeAfterExit(w.dir);
    return 0;
}

}  // namespace

bool setupRequested() {
    int n = 0;
    LPWSTR* a = CommandLineToArgvW(GetCommandLineW(), &n);
    bool yes = false;
    for (int i = 1; a && i < n; ++i) yes |= std::wcscmp(a[i], L"--setup") == 0 || std::wcscmp(a[i], L"--uninstall") == 0;
    if (a) LocalFree(a);
    return yes;
}

int setupCli(int argc, wchar_t** argv) {
    bool doSetup = false, doUninstall = false, quiet = false, keep = false, bad = false;
    fs::path root;
    std::wstring params;   // (the arguments again, for the elevated relaunch)
    for (int i = 1; i < argc; ++i) {
        const std::wstring a = argv[i];
        params += (params.empty() ? L"" : L" ") + (a.find(L' ') != std::wstring::npos ? L"\"" + a + L"\"" : a);
        if (a == L"--setup") doSetup = true;
        else if (a == L"--uninstall") doUninstall = true;
        else if (a == L"--quiet") quiet = true;
        else if (a == L"--keep-files") keep = true;
        else if (a == L"--test-root" && i + 1 < argc) {
            root = argv[++i];
            params += L" \"" + root.wstring() + L"\"";
        } else bad = true;
    }
    if (!doSetup && !doUninstall) return -1;
    if (bad || (doSetup && doUninstall) || (doSetup && (quiet || keep))) return 2;
    Where w;
    w.root = root;
    wchar_t self[MAX_PATH];
    GetModuleFileNameW(nullptr, self, MAX_PATH);
    w.exe = fs::path(self);
    w.dir = w.exe.parent_path();
    if (w.test()) {
        std::error_code ec;
        fs::create_directories(w.root, ec);
        w.root = fs::absolute(w.root, ec);
    }
    if (doSetup) return setup(w);
    if (keep) {   // (the manager's form: elevated already, the app checked not running; the folder is the manager's)
        if (!quiet) return 2;
        return unsetup(w) ? 0 : 1;
    }
    if (w.test()) return 2;   // (the user's forms touch the real system only)
    return uninstallFull(w, quiet, params);
}

}  // namespace latch

#else
namespace latch {
int setupCli(int, wchar_t**) { return -1; }
bool setupRequested() { return false; }
}  // namespace latch
#endif
