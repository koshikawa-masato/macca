//go:build darwin

package server

import "syscall"

// mountKind はマウント先のファイルシステム種別から、ネットワークマウント
// (NAS など) かローカルのリムーバブル (SD/USB など) かを判定する。
func mountKind(path string) string {
	var st syscall.Statfs_t
	if syscall.Statfs(path, &st) != nil {
		return "removable"
	}
	// Fstypename は NUL 終端の固定長配列
	b := make([]byte, 0, len(st.Fstypename))
	for _, c := range st.Fstypename {
		if c == 0 {
			break
		}
		b = append(b, byte(c))
	}
	switch string(b) {
	case "smbfs", "afpfs", "nfs", "webdav", "cifs":
		return "network"
	}
	return "removable"
}
