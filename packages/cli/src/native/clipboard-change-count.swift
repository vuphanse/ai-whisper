import AppKit

// Prints NSPasteboard.general.changeCount (a monotonically increasing integer
// advanced by exactly +1 on each clipboard write). Count only — never content.
print(NSPasteboard.general.changeCount)
