import Cocoa
import Darwin

// MARK: - fn usage helper
// `--fn-usage get|set <0-3>|delete` manages the system "Press fn key to" action
// (com.apple.HIToolbox AppleFnUsageType). Writing the preference alone is not
// enough: HIToolbox caches it, so the private TISUpdateFnUsageType is called to
// apply the change live, the same way System Settings does.
private let fnUsageDomain = "com.apple.HIToolbox"
private let fnUsageKey = "AppleFnUsageType"
private let fnUsageFactoryDefault: Int32 = 2 // Show Emoji & Symbols

private typealias TISUpdateFnUsageTypeFn = @convention(c) (Int32) -> Void

private func applyFnUsageLive(_ value: Int32) -> Bool {
    let candidates = [
        "/System/Library/Frameworks/Carbon.framework/Frameworks/HIToolbox.framework/HIToolbox",
        "/System/Library/Frameworks/Carbon.framework/Carbon",
    ]
    for library in candidates {
        guard let handle = dlopen(library, RTLD_NOW),
              let symbol = dlsym(handle, "TISUpdateFnUsageType") else { continue }
        unsafeBitCast(symbol, to: TISUpdateFnUsageTypeFn.self)(value)
        return true
    }
    return false
}

if let modeIndex = CommandLine.arguments.firstIndex(of: "--fn-usage") {
    let args = Array(CommandLine.arguments.dropFirst(modeIndex + 1))
    let defaults = UserDefaults(suiteName: fnUsageDomain)
    switch args.first {
    case "get":
        if let value = defaults?.object(forKey: fnUsageKey) as? Int {
            print(value)
        } else {
            print("absent")
        }
        exit(0)
    case "set":
        guard args.count > 1, let value = Int32(args[1]), (0...3).contains(value) else {
            FileHandle.standardError.write("usage: --fn-usage set <0-3>\n".data(using: .utf8)!)
            exit(2)
        }
        defaults?.set(Int(value), forKey: fnUsageKey)
        defaults?.synchronize()
        print(applyFnUsageLive(value) ? "ok" : "written-no-live-update")
        exit(0)
    case "delete":
        defaults?.removeObject(forKey: fnUsageKey)
        defaults?.synchronize()
        print(applyFnUsageLive(fnUsageFactoryDefault) ? "ok" : "written-no-live-update")
        exit(0)
    default:
        FileHandle.standardError.write("usage: --fn-usage get|set <0-3>|delete\n".data(using: .utf8)!)
        exit(2)
    }
}

var fnIsDown = false
var fnInterrupted = false
var lastModifierFlags: NSEvent.ModifierFlags = []

// "--swallow-fn": consume bare fn/Globe presses before macOS sees them, so its
// own fn action (Emoji picker, input-source switch, Dictation) never fires
// while VoiceLab uses the key. fn+key combos keep their fn flag and pass through.
let swallowFn = CommandLine.arguments.contains("--swallow-fn")

let suppressedMouseButtons = Set(
    CommandLine.arguments.dropFirst()
        .filter { !$0.hasPrefix("--") }
        .flatMap { $0.split(separator: ",") }
        .map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }
        .filter { !$0.isEmpty }
)

let fnKeyCode: Int64 = 63

func handleFnState(_ containsFn: Bool) {
    if containsFn && !fnIsDown {
        fnIsDown = true
        fnInterrupted = false
        emit("FN_DOWN")
    } else if !containsFn && fnIsDown {
        fnIsDown = false
        fnInterrupted = false
        emit("FN_UP")
    }
}

let rightModifiers: [(UInt16, NSEvent.ModifierFlags, String)] = [
    (61, .option, "RightOption"),
    (54, .command, "RightCommand"),
    (62, .control, "RightControl"),
    (60, .shift, "RightShift"),
]

let modifierMask: NSEvent.ModifierFlags = [.control, .command, .option, .shift]

let releases: [(NSEvent.ModifierFlags, String)] = [
    (.control, "control"),
    (.command, "command"),
    (.option, "option"),
    (.shift, "shift"),
]

func emit(_ message: String) {
    FileHandle.standardOutput.write((message + "\n").data(using: .utf8)!)
    fflush(stdout)
}

func mouseButtonName(_ buttonNumber: Int) -> String? {
    switch buttonNumber {
    case 3:
        return "MouseButton4"
    case 4:
        return "MouseButton5"
    default:
        return nil
    }
}

func emitMouseEvent(_ type: CGEventType, _ event: CGEvent) -> Bool {
    guard type == .otherMouseDown || type == .otherMouseUp else { return false }

    let buttonNumber = Int(event.getIntegerValueField(.mouseEventButtonNumber))
    guard let buttonName = mouseButtonName(buttonNumber) else { return false }

    emit(type == .otherMouseDown ? "MOUSE_BUTTON_DOWN:\(buttonName)" : "MOUSE_BUTTON_UP:\(buttonName)")
    return suppressedMouseButtons.contains(buttonName)
}

let mouseEventMask =
    (1 << CGEventType.otherMouseDown.rawValue) |
    (1 << CGEventType.otherMouseUp.rawValue)

var mouseEventTapPort: CFMachPort?

let mouseEventTap = CGEvent.tapCreate(
    tap: .cgSessionEventTap,
    place: .headInsertEventTap,
    options: .defaultTap,
    eventsOfInterest: CGEventMask(mouseEventMask),
    callback: { _, type, event, _ in
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let mouseEventTapPort {
                CGEvent.tapEnable(tap: mouseEventTapPort, enable: true)
            }
            return Unmanaged.passUnretained(event)
        }

        if emitMouseEvent(type, event) {
            return nil
        }

        return Unmanaged.passUnretained(event)
    },
    userInfo: nil
)

var fnEventTapPort: CFMachPort?
var fnRunLoopSource: CFRunLoopSource?
// True once an active tap owns the fn key; the NSEvent monitor then stays out.
var fnTapActive = false

func fnTapCallback(
    _ proxy: CGEventTapProxy, _ type: CGEventType, _ event: CGEvent, _ refcon: UnsafeMutableRawPointer?
) -> Unmanaged<CGEvent>? {
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        if let fnEventTapPort {
            CGEvent.tapEnable(tap: fnEventTapPort, enable: true)
        }
        return Unmanaged.passUnretained(event)
    }

    guard event.getIntegerValueField(.keyboardEventKeycode) == fnKeyCode else {
        return Unmanaged.passUnretained(event)
    }

    // Swallow the bare fn press so the frontmost app never sees it and macOS
    // does not run its own fn action.
    if type == .flagsChanged {
        handleFnState(event.flags.contains(.maskSecondaryFn))
    }
    return nil
}

if swallowFn {
    // A physical fn key only produces flagsChanged events. Taps that also
    // cover key events need Input Monitoring and may silently receive nothing,
    // so stay with the modifier stream.
    let masks: [CGEventMask] = [CGEventMask(1 << CGEventType.flagsChanged.rawValue)]
    for mask in masks {
        guard let tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .defaultTap,
            eventsOfInterest: mask,
            callback: fnTapCallback,
            userInfo: nil
        ) else { continue }
        fnEventTapPort = tap
        fnRunLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        CFRunLoopAddSource(CFRunLoopGetMain(), fnRunLoopSource, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        fnTapActive = true
        break
    }
    if !fnTapActive {
        FileHandle.standardError.write(
            "Failed to create fn event tap; falling back to observe-only fn\n".data(using: .utf8)!)
    }
}

var mouseRunLoopSource: CFRunLoopSource?
if let mouseEventTap {
    mouseEventTapPort = mouseEventTap
    mouseRunLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, mouseEventTap, 0)
    CFRunLoopAddSource(CFRunLoopGetMain(), mouseRunLoopSource, .commonModes)
    CGEvent.tapEnable(tap: mouseEventTap, enable: true)
} else {
    FileHandle.standardError.write("Failed to create mouse event tap\n".data(using: .utf8)!)
}

guard let monitor = NSEvent.addGlobalMonitorForEvents(matching: .flagsChanged, handler: { event in
    let flags = event.modifierFlags

    // With the fn tap active the swallowed events never reach this monitor;
    // the tap reports the fn state itself.
    if !fnTapActive {
        handleFnState(flags.contains(.function))
    }

    let keyCode = event.keyCode
    for (code, flag, name) in rightModifiers {
        if keyCode == code {
            emit(flags.contains(flag) ? "RIGHT_MOD_DOWN:\(name)" : "RIGHT_MOD_UP:\(name)")
            break
        }
    }

    let currentModifiers = flags.intersection(modifierMask)
    if currentModifiers != lastModifierFlags {
        let released = lastModifierFlags.subtracting(currentModifiers)
        for (flag, name) in releases {
            if released.contains(flag) {
                emit("MODIFIER_UP:\(name)")
            }
        }
        lastModifierFlags = currentModifiers
    }
}) else {
    FileHandle.standardError.write("Failed to create event monitor\n".data(using: .utf8)!)
    exit(1)
}

// Detect another key pressed while Fn is held (e.g. Fn+Arrow → Home) so the
// JS side can cancel an in-progress bare-Fn push-to-talk instead of transcribing noise.
let keyMonitor = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { event in
    // Synthetic fn presses (e.g. automation) arrive as keyDown 63 as well; the
    // fn key itself never interrupts a bare-fn gesture.
    if event.keyCode == UInt16(fnKeyCode) { return }
    if fnIsDown && !fnInterrupted {
        fnInterrupted = true
        emit("FN_INTERRUPTED")
    }
}

let signalSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
signal(SIGTERM, SIG_IGN)
signalSource.setEventHandler {
    NSEvent.removeMonitor(monitor)
    if let keyMonitor {
        NSEvent.removeMonitor(keyMonitor)
    }
    if let mouseEventTap {
        CGEvent.tapEnable(tap: mouseEventTap, enable: false)
    }
    if let fnEventTapPort {
        CGEvent.tapEnable(tap: fnEventTapPort, enable: false)
    }
    if let mouseRunLoopSource {
        CFRunLoopRemoveSource(CFRunLoopGetMain(), mouseRunLoopSource, .commonModes)
    }
    exit(0)
}
signalSource.resume()

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
app.run()
