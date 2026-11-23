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
	"sync"
	"time"

	"github.com/egoist/mygo"
)

// The house is the ade server and its runner on this machine. When the
// window's server doesn't answer and it lives here (localhost), the app can
// start it: inside WSL on Windows, directly on Linux and macOS. It starts
// detached, so it outlives the window and agents finish their work. The page
// restarts it in place to update, so it keeps its process and house.sh's
// token.

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

// runHouse runs house.sh with an action: start or status. It answers
// the script's output: the log's path, then the house's state.
func runHouse(ctx context.Context, action string, h house) (string, error) {
	dir := h.dir()
	if dir == "~" || strings.HasPrefix(dir, "~/") {
		dir = `"$HOME"` + shellQuote(strings.TrimPrefix(dir, "~"))
	} else {
		dir = shellQuote(dir)
	}
	script := "HOUSE_DIR=" + dir + "\nHOUSE_COMMAND=" + shellQuote(h.command()) + "\nHOUSE_SCRIPT=" + shellQuote(houseScript) + "\n" + houseScript
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
		setHouseNote("Couldn't start the house: "+err.Error(), false)
		return false
	}
	if strings.HasSuffix(out, "installing") {
		setHouseNote("Setting up ade, the first time only: fetching it and its packages takes a minute or two.", true)
	} else {
		setHouseNote("Starting the house in "+h.dir()+"…", true)
	}
	return true
}

// The house's note on the offline page, and whether the house is on its way
// up, when the log's last line shows how far it got.
var houseNote struct {
	sync.Mutex
	text     string
	starting bool
}

func setHouseNote(text string, starting bool) {
	houseNote.Lock()
	houseNote.text, houseNote.starting = text, starting
	houseNote.Unlock()
}

// House is what the offline page says about the house, checked every two
// seconds.
func (Desktop) House() string {
	houseNote.Lock()
	text, starting := houseNote.text, houseNote.starting
	houseNote.Unlock()
	if starting {
		if last := lastLines(1); last != "" {
			return text + "\n" + last
		}
	}
	return text
}

// lastLines is the end of the house log.
func lastLines(n int) string {
	data, err := os.ReadFile(houseLog)
	if err != nil {
		return ""
	}
	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	return strings.Join(lines[max(0, len(lines)-n):], "\n")
}

// houseStopped tells the offline page when a house it is waiting for stops,
// with the log's last lines; Try now starts it again.
func houseStopped() bool {
	houseNote.Lock()
	starting := houseNote.starting
	houseNote.Unlock()
	if !starting {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	out, err := runHouse(ctx, "status", loadHouse())
	if err != nil || !strings.HasSuffix(out, "stopped") {
		return false
	}
	setHouseNote("The house stopped; the log says why: "+houseLog+"\n"+lastLines(8), false)
	return true
}

// updateHouse brings the ade the app keeps up to GitHub's main, every hour;
// the page then offers Update. A house running ade you installed is left alone.
func updateHouse() {
	for {
		if h := loadHouse(); h.Start != nil && *h.Start && local(origin) {
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			_, _ = runHouse(ctx, "update", h)
			cancel()
		}
		time.Sleep(time.Hour)
	}
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

// Login opens pi in a terminal on this machine, to log in to a model with
// /login; the page offers it when the house's runner has none.
func (Desktop) Login() error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	_, err := runHouse(ctx, "login", loadHouse())
	return err
}

// findLog learns where the log is before anything starts, for Open house log.
func findLog() {
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		out, _ := runHouse(ctx, "status", loadHouse())
		noteLog(out)
	}()
}

// houseMenu is the switch and the log. Ticking the switch while nothing
// answers starts the house at once; to update, the page restarts it. On macOS
// it sits among the usual menus, since Edit is what makes Cmd+A, C and V work.
func houseMenu() *mygo.Menu {
	house := houseItem()
	if runtime.GOOS != "darwin" {
		return mygo.NewMenu([]*mygo.MenuItem{house})
	}
	return mygo.NewMenu([]*mygo.MenuItem{
		{Role: mygo.RoleAppMenu},
		{Role: mygo.RoleFileMenu},
		{Role: mygo.RoleEditMenu},
		{Role: mygo.RoleViewMenu},
		house,
		{Role: mygo.RoleWindowMenu},
	})
}

func houseItem() *mygo.MenuItem {
	h := loadHouse()
	return &mygo.MenuItem{Label: "House", Submenu: []*mygo.MenuItem{
		{
			Label:   "Start house when it's down",
			Type:    mygo.MenuItemCheckbox,
			Checked: h.Start != nil && *h.Start,
			Click: func(item *mygo.MenuItem, _ *mygo.Window) {
				h := loadHouse()
				on := item.IsChecked()
				h.Start = &on
				saveHouse(h)
				if on && local(origin) {
					go func() {
						if !reachable() {
							startHouse()
						}
					}()
				}
			},
		},
		{Label: "Open house log", Click: func(*mygo.MenuItem, *mygo.Window) {
			if houseLog != "" {
				go mygo.Shell.OpenPath(houseLog)
			}
		}},
	}}
}
