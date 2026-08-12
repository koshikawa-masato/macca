//go:build windows

package server

import (
	"runtime"
	"time"
)

// Windows では簡易版: CPU 時間は非対応 (0)、メモリは Go ランタイムの確保量
func processCPUTime() time.Duration { return 0 }

func processRSS() int64 {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	return int64(m.Sys)
}
