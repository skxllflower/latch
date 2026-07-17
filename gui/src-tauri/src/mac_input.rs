// Permission-free global input reads for macOS.
//
// device_query's DeviceState::new() asserts Accessibility trust
// (AXIsProcessTrustedWithOptions) and PANICS when the app isn't in the TCC
// list — on a fresh install that pops the OS permission dialog and, with
// panic=abort, kills the process mid-drag (the latch first-drag crash;
// lockstep with wavdesk's mac_input.rs). NSEvent's
// class-level state getters need no permission at all and are safe from any
// thread (they read CGEventSource hardware state, not the event queue):
//   +[NSEvent pressedMouseButtons]  — bit 0 = left, bit 1 = right
//   +[NSEvent modifierFlags]        — NSEventModifierFlag* bits
#![cfg(target_os = "macos")]

use objc2::{class, msg_send};

pub fn pressed_mouse_buttons() -> u64 {
    unsafe { msg_send![class!(NSEvent), pressedMouseButtons] }
}

pub fn modifier_flags() -> u64 {
    unsafe { msg_send![class!(NSEvent), modifierFlags] }
}

pub const FLAG_SHIFT: u64 = 1 << 17;
#[allow(dead_code)]
pub const FLAG_CONTROL: u64 = 1 << 18;
pub const FLAG_OPTION: u64 = 1 << 19;
pub const FLAG_COMMAND: u64 = 1 << 20;
