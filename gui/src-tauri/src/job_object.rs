// Tie every child process WAVdesk spawns to this process's lifetime via a
// Windows Job Object created with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE. When this
// process goes away FOR ANY REASON — clean exit, panic, a hard native crash, or
// being force-killed in Task Manager — the OS closes the job handle and
// terminates every process still in it, and (by job inheritance) their entire
// descendant trees (e.g. ffmpeg under lathe). This is the only orphan
// prevention that survives a hard crash: Drop, stdin-EOF, and explicit .kill()
// all require our own code to run, which a crash skips.
//
// Detached OS launches (explorer / open / xdg-open / gtk-launch) are
// deliberately NOT assigned — the user opened those to use them, so they must
// outlive us.

#[cfg(windows)]
mod imp {
    use std::ffi::c_void;
    use std::sync::OnceLock;

    use windows::core::PCWSTR;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject,
        JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows::Win32::System::Threading::GetCurrentProcess;

    // Held for the whole process lifetime and NEVER closed by us: the OS closing
    // it (when we die) is precisely what triggers the kill-on-close.
    struct Job(HANDLE);
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    static JOB: OnceLock<Option<Job>> = OnceLock::new();

    fn job_handle() -> Option<HANDLE> {
        JOB.get_or_init(|| unsafe {
            let h = CreateJobObjectW(None, PCWSTR::null()).ok()?;
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(
                h,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
            .ok()?;
            Some(Job(h))
        })
        .as_ref()
        .map(|j| j.0)
    }

    pub fn assign(raw: *mut c_void) {
        if raw.is_null() {
            return;
        }
        if let Some(job) = job_handle() {
            // Best-effort: a failure (e.g. child already exited) just leaves
            // that one child unmanaged; never abort a spawn over it.
            unsafe {
                let _ = AssignProcessToJobObject(job, HANDLE(raw));
            }
        }
    }

    pub fn assign_self() {
        if let Some(job) = job_handle() {
            // Put THIS process in the kill-on-close job. Every process we go on to
            // spawn — including the WebView2 processes the runtime creates for us,
            // which assign_child never sees — then inherits the job and is
            // terminated when we die for ANY reason. On Win8+ this nests under any
            // job a launcher already placed us in; if assignment fails (older OS /
            // non-nestable parent job) it's a best-effort no-op and assign_child
            // still covers the daemons.
            unsafe {
                let _ = AssignProcessToJobObject(job, GetCurrentProcess());
            }
        }
    }
}

/// Tie a freshly-spawned child to this process via a kill-on-close Job Object,
/// so it can never outlive us — even on a hard crash. Call right after spawn().
/// No-op on non-Windows — POSIX instead binds each spawned wavdesk binary to
/// its parent from the child side (install_parent_death_watch in the C++ core,
/// gated by the WAVDESK_DIE_WITH_PARENT env var the GUI sets process-wide).
pub fn assign_child(child: &std::process::Child) {
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        imp::assign(child.as_raw_handle());
    }
    #[cfg(not(windows))]
    {
        let _ = child;
    }
}

/// Put THIS process into the kill-on-close Job Object at startup, so the entire
/// descendant tree — including the WebView2 processes Tauri spawns, which
/// `assign_child` can't reach — dies with us even on a hard crash. Call as early
/// as possible in `run()`, before any window (and thus any webview) is created.
/// No-op on non-Windows (POSIX uses the per-child parent-death watch instead).
pub fn assign_self() {
    #[cfg(windows)]
    {
        imp::assign_self();
    }
}
