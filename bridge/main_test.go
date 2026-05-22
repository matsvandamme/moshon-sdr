package main

import "testing"

func TestOriginHostPattern(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"https://moshon-sdr.pages.dev", "moshon-sdr.pages.dev"},
		{"http://localhost:5173", "localhost:5173"},
		{"  https://example.com/  ", "example.com"},
		{"example.com", "example.com"},
		{"", "*"},
	}
	for _, c := range cases {
		if got := originHostPattern(c.in); got != c.want {
			t.Errorf("originHostPattern(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestIsPlausibleTarget(t *testing.T) {
	good := []string{
		"127.0.0.1:1234",
		"localhost:1234",
		"[::1]:1234",
		"rtl-pi.lan:1234",
	}
	bad := []string{
		"",
		"127.0.0.1",
		":1234",
		"127.0.0.1:",
		"localhost:abc",
		"localhost:12 34",
	}
	for _, t1 := range good {
		if !isPlausibleTarget(t1) {
			t.Errorf("isPlausibleTarget(%q) = false, want true", t1)
		}
	}
	for _, t1 := range bad {
		if isPlausibleTarget(t1) {
			t.Errorf("isPlausibleTarget(%q) = true, want false", t1)
		}
	}
}
