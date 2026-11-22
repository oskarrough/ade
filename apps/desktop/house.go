package main

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/egoist/mygo"
)

// The house is the ade server and its runner on this machine. When the
// window's server doesn't answer and it lives here (localhost), the app can
// start it: inside WSL on Windows, directly on Linux and macOS. It starts
// detached, so it outlives the window and agents finish their work; "Stop
// house" stops only the one this app started, which house.sh remembers by
// its process group.

//go:embed house.sh
var houseScript string

type house struct {
	// Start is whether the app starts the house when nothing answers; nil
	// until asked.
	Start *bool `json:"start,omitempty"`
	// Dir is the folder it starts in, the runner's folder; "~" by default.
	Dir string `json:"dir,omitempty"`
	// Command starts it, as you would in a terminal there; "ade" by default.
	Command string `json:"command,omitempty"`
}

func (h house) dir() string {
	if h.Dir == "" {
		return "~"
	}
	return h.Dir
}

func (h house) command() string {
	if h.Command == "" {
		return "ade"
	}
	return h.Command
}

// The house's settings have a file of their own, house.json beside
// settings.json, so an older app that rewrites settings.json keeps them.
func housePath() string {
	dir, err := mygo.App.Path(mygo.PathUserData)
	if err != nil {
		return ""
	}
	return filepath.Join(dir, "house.json")
}

func loadHouse() (h house) {
	if data, err := os.ReadFile(housePath()); err == nil {
		_ = json.Unmarshal(data, &h)
	}
	return h
}

func saveHouse(h house) {
	data, _ := json.MarshalIndent(h, "", "\t")
	_ = os.WriteFile(housePath(), data, 0o600)
}

// local is whether the server's address is this machine, the only house the
// app can start.
func local(origin string) bool {
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	switch u.Hostname() {
	case "localhost", "127.0.0.1", "::1":
		return true
	}
	return false
}

// shellQuote quotes s for sh.
func shellQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }

// runHouse runs house.sh with an action: start, stop or status. It answers
// the script's output: the log's path, then the house's state.
func runHouse(ctx context.Context, action string, h house) (string, error) {
	dir := h.dir()
	if dir == "~" || strings.HasPrefix(dir, "~/") {
		dir = `"$HOME"` + shellQuote(strings.TrimPrefix(dir, "~"))
	} else {
		dir = shellQuote(dir)
	}
	script := "HOUSE_DIR=" + dir + "\nHOUSE_COMMAND=" + shellQuote(h.command()) + "\n" + houseScript
	// The login shell's environment, as in a terminal: PATH with node and ade
	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		cmd = exec.CommandContext(ctx, "wsl.exe", "--cd", "~", "-e", "sh", "-c", `exec "${SHELL:-sh}" -lc "exec sh -s `+action+`"`)
	} else {
		cmd = exec.CommandContext(ctx, "sh", "-c", `exec "${SHELL:-sh}" -lc "exec sh -s `+action+`"`)
	}
	hideWindow(cmd)
	cmd.Stdin = strings.NewReader(script)
	var out, problem bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &problem
	err := cmd.Run()
	text := strings.TrimSpace(out.String())
	if err != nil {
		if msg := strings.TrimSpace(problem.String() + "\n" + text); msg != "" {
			return text, errors.New(msg)
		}
		return text, err
	}
	return text, nil
}

// houseLog is the log house.sh named, as a path this machine opens: on
// Windows, the WSL file through \\wsl.localhost.
var houseLog string

func noteLog(out string) {
	first, _, _ := strings.Cut(out, "\n")
	distro, file, ok := strings.Cut(first, ":")
	if !ok || file == "" {
		return
	}
	if runtime.GOOS == "windows" && distro != "" {
		houseLog = `\\wsl.localhost\` + distro + strings.ReplaceAll(file, "/", `\`)
	} else {
		houseLog = file
	}
}

// startHouse starts the house unless it is set not to; true when it started
// one, or one this app started is already starting.
func startHouse() bool {
	h := loadHouse()
	if h.Start == nil {
		start := askToStart()
		h = loadHouse()
		h.Start = &start
		saveHouse(h)
	}
	if !*h.Start {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	out, err := runHouse(ctx, "start", h)
	noteLog(out)
	if err != nil {
		houseNote = "Couldn't start the house: " + err.Error()
		return false
	}
	houseNote = "Starting the house in " + h.dir() + "…"
	updateHouseMenu()
	return true
}

func askToStart() bool {
	answer := make(chan bool, 1)
	mygo.RunOnMain(func() {
		res, err := mygo.Dialog.Message(mygo.MessageOptions{
			Parent:  win,
			Title:   "arbe desktop",
			Message: "Start ade when it isn't running?",
			Detail: fmt.Sprintf("Nothing answers at %s. arbe desktop can start the server and a runner here, running %q in your home folder, and leave them running when you close the window. Change it later in the House menu (Alt).",
				origin, "ade"),
			Buttons:       []string{"Start ade", "Not now"},
			DefaultButton: 0,
			CancelButton:  1,
		})
		answer <- err == nil && res.Button == 0
	})
	return <-answer
}

// houseNote is what the offline page says about the house.
var houseNote string

func stopHouse() {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	out, err := runHouse(ctx, "stop", loadHouse())
	noteLog(out)
	if err != nil {
		mygo.RunOnMain(func() {
			_, _ = mygo.Dialog.Message(mygo.MessageOptions{Parent: win, Title: "arbe desktop", Message: "Couldn't stop the house", Detail: err.Error()})
		})
	}
	updateHouseMenu()
}

// houseItems are the House menu's items that change.
var houseItems struct{ stop, start, auto *mygo.MenuItem }

// updateHouseMenu enables Stop only while a house this app started runs.
func updateHouseMenu() {
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		out, _ := runHouse(ctx, "status", loadHouse())
		noteLog(out)
		ours := strings.HasSuffix(out, "running")
		mygo.RunOnMain(func() {
			if houseItems.stop != nil {
				houseItems.stop.SetEnabled(ours)
				houseItems.start.SetEnabled(!ours)
			}
		})
	}()
}

func houseMenu() *mygo.Menu {
	h := loadHouse()
	houseItems.stop = &mygo.MenuItem{Label: "Stop house", Disabled: true, Click: func(*mygo.MenuItem, *mygo.Window) { go stopHouse() }}
	houseItems.start = &mygo.MenuItem{Label: "Start house", Click: func(*mygo.MenuItem, *mygo.Window) {
		go func() {
			if !reachable() {
				on := true
				h := loadHouse()
				if h.Start == nil {
					h.Start = &on
					saveHouse(h)
				}
				startHouse()
			}
		}()
	}}
	houseItems.auto = &mygo.MenuItem{
		Label:   "Start house when it's down",
		Type:    mygo.MenuItemCheckbox,
		Checked: h.Start != nil && *h.Start,
		Click: func(item *mygo.MenuItem, _ *mygo.Window) {
			h := loadHouse()
			on := item.IsChecked()
			h.Start = &on
			saveHouse(h)
		},
	}
	return mygo.NewMenu([]*mygo.MenuItem{{Label: "House", Submenu: []*mygo.MenuItem{
		houseItems.start,
		houseItems.stop,
		mygo.Separator(),
		houseItems.auto,
		{Label: "Open house log", Click: func(*mygo.MenuItem, *mygo.Window) {
			if houseLog != "" {
				go mygo.Shell.OpenPath(houseLog)
			}
		}},
		{Label: "Show house folder", Click: func(*mygo.MenuItem, *mygo.Window) {
			if houseLog != "" {
				go mygo.Shell.ShowItemInFolder(houseLog)
			}
		}},
	}}})
}
