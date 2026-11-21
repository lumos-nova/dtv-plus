//go:build windows

package services

import "golang.org/x/sys/windows"

// diskFreeBytes 返回路径所在卷对当前用户可用的剩余字节数。
func diskFreeBytes(path string) (uint64, error) {
	ptr, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return 0, err
	}
	var freeAvailable, total, totalFree uint64
	if err := windows.GetDiskFreeSpaceEx(ptr, &freeAvailable, &total, &totalFree); err != nil {
		return 0, err
	}
	return freeAvailable, nil
}
