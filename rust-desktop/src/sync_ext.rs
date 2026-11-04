//! Poisoned-lock recovery + Windows Job Object helpers.

use std::sync::{Mutex, MutexGuard, RwLock, RwLockReadGuard, RwLockWriteGuard};

pub trait MutexExt<T> {
    fn lock_safe(&self) -> MutexGuard<'_, T>;
}

impl<T> MutexExt<T> for Mutex<T> {
    fn lock_safe(&self) -> MutexGuard<'_, T> {
        self.lock().unwrap_or_else(|p| p.into_inner())
    }
}

pub trait RwLockExt<T> {
    fn read_safe(&self) -> RwLockReadGuard<'_, T>;
    fn write_safe(&self) -> RwLockWriteGuard<'_, T>;
}

impl<T> RwLockExt<T> for RwLock<T> {
    fn read_safe(&self) -> RwLockReadGuard<'_, T> {
        self.read().unwrap_or_else(|p| p.into_inner())
    }
    fn write_safe(&self) -> RwLockWriteGuard<'_, T> {
        self.write().unwrap_or_else(|p| p.into_inner())
    }
}

/// Raw FFI: assign a spawned child to a Job Object created with
/// JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE so it cannot outlive this process.
#[cfg(target_os = "windows")]
pub struct JobHandle(#[allow(dead_code)] pub *mut std::ffi::c_void);
#[cfg(target_os = "windows")]
unsafe impl Send for JobHandle {}
#[cfg(target_os = "windows")]
unsafe impl Sync for JobHandle {}

#[cfg(target_os = "windows")]
pub fn assign_to_kill_job(child: &std::process::Child, slot: &Mutex<Option<JobHandle>>) {
    #[repr(C)]
    struct IoCounters {
        read_operation_count: u64,
        write_operation_count: u64,
        other_operation_count: u64,
        read_transfer_count: u64,
        write_transfer_count: u64,
        other_transfer_count: u64,
    }
    #[repr(C)]
    struct BasicLimitInformation {
        per_process_user_time_limit: i64,
        per_job_user_time_limit: i64,
        limit_flags: u32,
        _pad: u32,
        minimum_working_set_size: usize,
        maximum_working_set_size: usize,
        active_process_limit: u32,
        _pad2: u32,
        affinity: usize,
        priority_class: u32,
        scheduling_class: u32,
    }
    #[repr(C)]
    struct ExtendedLimitInformation {
        basic: BasicLimitInformation,
        io: IoCounters,
        process_memory_limit: usize,
        job_memory_limit: usize,
        peak_process_memory_used: usize,
        peak_job_memory_used: usize,
    }
    const _: () = assert!(std::mem::size_of::<ExtendedLimitInformation>() == 144);

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateJobObjectW(attrs: *const std::ffi::c_void, name: *const u16) -> *mut std::ffi::c_void;
        fn SetInformationJobObject(
            job: *mut std::ffi::c_void,
            info_class: u32,
            info: *const std::ffi::c_void,
            len: u32,
        ) -> i32;
        fn AssignProcessToJobObject(job: *mut std::ffi::c_void, process: *mut std::ffi::c_void) -> i32;
    }

    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x2000;
    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            eprintln!("[TeleDrive] CreateJobObjectW failed — child will rely on Drop cleanup");
            return;
        }
        let mut info: ExtendedLimitInformation = std::mem::zeroed();
        info.basic.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if SetInformationJobObject(job, 9, &info as *const _ as *const _, 144) == 0 {
            eprintln!("[TeleDrive] SetInformationJobObject failed — child will rely on Drop cleanup");
            return;
        }
        use std::os::windows::io::AsRawHandle;
        if AssignProcessToJobObject(job, child.as_raw_handle() as *mut _) == 0 {
            eprintln!("[TeleDrive] AssignProcessToJobObject failed — child will rely on Drop cleanup");
            return;
        }
        *slot.lock_safe() = Some(JobHandle(job));
    }
}
