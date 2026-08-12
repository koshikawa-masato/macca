//go:build unix

package server

import (
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// processCPUTime は自プロセスの累積 CPU 時間 (user+sys) を返す
func processCPUTime() time.Duration {
	var ru syscall.Rusage
	if err := syscall.Getrusage(syscall.RUSAGE_SELF, &ru); err != nil {
		return 0
	}
	return time.Duration(ru.Utime.Nano() + ru.Stime.Nano())
}

// processRSS は自プロセスの現在の常駐メモリ (バイト) を返す。取れなければ 0
func processRSS() int64 {
	// macOS / Linux とも ps で取るのが依存ゼロで確実 (KB 単位)
	out, err := exec.Command("ps", "-o", "rss=", "-p", strconv.Itoa(os.Getpid())).Output()
	if err != nil {
		return 0
	}
	kb, err := strconv.ParseInt(strings.TrimSpace(string(out)), 10, 64)
	if err != nil {
		return 0
	}
	return kb * 1024
}
