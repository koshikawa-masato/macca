//go:build !darwin

package server

// mountKind は darwin 以外では判定手段を持たないため、常にリムーバブル扱い。
func mountKind(path string) string {
	return "removable"
}
