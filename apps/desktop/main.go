// arbe desktop: ade in its own window. One window around an ade server's URL
// that remembers where it was, sends other sites to the browser, waits with a
// page of its own while the server is down, turns threads that finish or ask
// you something into the system's notifications, and updates itself.
//
//	go run . -url http://localhost:3000
//
// The URL is kept in the app's data folder, so later starts need no flag.
package main

import (
	"context"
	_ "embed"
	"encoding/json"
	"flag"
	"fmt"
	"html"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/plugins/updater"
)

//go:embed preload.js
var preload string

//go:embed offline.html
var offlinePage string

var (
	win     *mygo.Window
	origin  string // the ade server, as scheme://host:port
	focused atomic.Bool
)

type settings struct {
	URL  string `json:"url"`  // the server
	Last string `json:"last"` // the page the window showed when it closed
}

func settingsPath() string {
	dir, err := mygo.App.Path(mygo.PathUserData)
	if err != nil {
		return ""
	}
	return filepath.Join(dir, "settings.json")
}

func saveSettings(s settings) {
	data, _ := json.Marshal(s)
	_ = os.WriteFile(settingsPath(), data, 0o600)
}

func loadSettings() (s settings) {
	if data, err := os.ReadFile(settingsPath()); err == nil {
		_ = json.Unmarshal(data, &s)
	}
	return s
}

// startURL is the -url flag, else the page the last run closed on, else
// localhost:3000.
func startURL(flagged string) string {
	if flagged != "" {
		s := loadSettings()
		s.URL, s.Last = flagged, ""
		saveSettings(s)
		return flagged
	}
	if saved := loadSettings(); saved.Last != "" {
		return saved.Last
	} else if saved.URL != "" {
		return saved.URL
	}
	return "http://localhost:3000"
}

func originOf(raw string) (string, bool) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return "", false
	}
	return u.Scheme + "://" + u.Host, true
}

func sameOrigin(raw string) bool {
	found, ok := originOf(raw)
	return ok && found == origin
}

// Desktop is what the ade page, and the offline page, may call.
type Desktop struct{}

// Notify shows a notification about a thread, unless the window has the
// focus: then you are looking at it already.
func (Desktop) Notify(thread int, title, body string) error {
	if focused.Load() || !mygo.NotificationsSupported() {
		return nil
	}
	return mygo.NewNotification(mygo.NotificationOptions{
		ID:    fmt.Sprint(thread),
		Title: title,
		Body:  body,
		Group: "threads",
	}).Show()
}

// WriteText and ReadText stand in for navigator.clipboard on plain http over
// Tailscale, where the page isn't a secure context and the browser hides it.
func (Desktop) WriteText(text string) { mygo.Clipboard.WriteText(text) }
func (Desktop) ReadText() string      { return mygo.Clipboard.ReadText() }

// Version is this app's version, for the page to show.
func (Desktop) Version() string { return mygo.App.Version() }

// Menu shows labels as the system's context menu at the pointer, an empty one
// as a separator, and answers the index of the item picked, or -1.
func (Desktop) Menu(ctx context.Context, labels []string) int {
	picked := make(chan int, 1)
	items := make([]*mygo.MenuItem, len(labels))
	for i, label := range labels {
		if label == "" {
			items[i] = mygo.Separator()
			continue
		}
		items[i] = &mygo.MenuItem{Label: label, Click: func(*mygo.MenuItem, *mygo.Window) { picked <- i }}
	}
	mygo.NewMenu(items).Popup(mygo.CallerWindow(ctx))
	// A click may be delivered just after the menu closes, as on Windows
	select {
	case i := <-picked:
		return i
	case <-time.After(300 * time.Millisecond):
		return -1
	}
}

// SetServer points the app at another ade server and starts it again there,
// so the new server's page is the one trusted.
func (Desktop) SetServer(raw string) error {
	found, ok := originOf(raw)
	if !ok {
		return fmt.Errorf("%q is not an http or https address", raw)
	}
	s := loadSettings()
	s.URL, s.Last = found, ""
	saveSettings(s)
	mygo.App.Relaunch()
	return nil
}

// The offline page: shown when the server can't be reached, it checks again
// every two seconds and goes back to the page you were on once it answers.
var tryNow = make(chan struct{}, 1)

// TryNow checks the server at once rather than at the next two seconds.
func (Desktop) TryNow() {
	select {
	case tryNow <- struct{}{}:
	default:
	}
}

var offline struct {
	sync.Mutex
	waiting bool
	target  string
}

func reachable() bool {
	client := http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get(origin + "/api/server")
	if err != nil {
		return false
	}
	resp.Body.Close()
	return resp.StatusCode < 500
}

func waitForServer(target string) {
	offline.Lock()
	offline.target = target
	if offline.waiting {
		offline.Unlock()
		return
	}
	offline.waiting = true
	offline.Unlock()

	setHouseNote("", false)
	if local(origin) {
		startHouse()
	}
	page := strings.ReplaceAll(offlinePage, "{{server}}", html.EscapeString(origin))
	page = strings.ReplaceAll(page, "{{house}}", html.EscapeString(Desktop{}.House()))
	mygo.RunOnMain(func() { win.Page().LoadHTML(page, "") })
	stopped := false
	for checks := 1; !reachable(); checks++ {
		select {
		case <-time.After(2 * time.Second):
		case <-tryNow:
			if stopped && local(origin) {
				stopped = !startHouse()
			}
		}
		if checks%5 == 0 && houseStopped() {
			stopped = true
		}
	}
	offline.Lock()
	offline.waiting = false
	target = offline.target
	offline.Unlock()
	mygo.RunOnMain(func() { _ = win.Page().LoadURL(target) })
}

func main() {
	flagHouse := flag.String("house", "", `start ade in this folder when it's down, e.g. ~/sites/ade ("off" never does)`)
	flagHouseCommand := flag.String("house-command", "", `with -house, the command that starts it (default "ade")`)
	flagURL := flag.String("url", "", "the ade server, e.g. http://localhost:3000 or http://box.tailnet.ts.net:3000")
	flag.Parse()

	if !mygo.App.RequestSingleInstanceLock() {
		return
	}
	mygo.Bind(Desktop{})
	// Checks 10 seconds after launch and every hour after, showing the update
	// window when a new version is out.
	mygo.Use(updater.New(updater.Options{Interval: time.Hour}))

	mygo.App.WhenReady(func() {
		if *flagHouse != "" {
			h := loadHouse()
			on := *flagHouse != "off"
			h.Start = &on
			if on {
				h.Dir, h.Command = *flagHouse, *flagHouseCommand
			}
			saveHouse(h)
		}
		// Alt, or F10, opens it in the window's corner
		mygo.App.SetMenu(houseMenu())
		findLog()
		go func() {
			time.Sleep(10 * time.Second)
			updateHouse()
		}()
		start := startURL(*flagURL)
		found, ok := originOf(start)
		if !ok {
			start, found = "http://localhost:3000", "http://localhost:3000"
		}
		origin = found

		win = mygo.NewWindow(mygo.WindowOptions{
			Title:           "arbe desktop",
			URL:             start,
			Width:           1280,
			Height:          860,
			MinWidth:        360,
			MinHeight:       400,
			StateKey:        "main",
			BackgroundColor: "#121212",
			TitleBarStyle:   mygo.TitleBarHidden,
			TitleBarHeight:  48,
			Hidden:          true,
			Page: mygo.PageOptions{
				// The ade server is ours: its page may call Desktop and gets
				// notifications and the clipboard without asking.
				TrustedOrigins: []string{origin},
				PreloadScript:  preload,
			},
		})
		win.OnReadyToShow(win.Show)
		win.OnFocus(func() { focused.Store(true); mygo.ClearNotifications() })
		win.OnBlur(func() { focused.Store(false) })
		// Open where you left off next time, as a browser tab would.
		win.OnClose(func(*mygo.CloseEvent) {
			if last := win.Page().URL(); sameOrigin(last) {
				s := loadSettings()
				s.URL, s.Last = origin, last
				saveSettings(s)
			}
		})

		page := win.Page()
		// The window keeps its own name rather than the page's "ade".
		page.OnPageTitleUpdated(func(e *mygo.TitleEvent) { e.PreventDefault() })
		// A server that doesn't answer gets the offline page, not the
		// webview's bare error; one that answers had some other failure.
		page.OnDidFailLoad(func(e *mygo.LoadError) {
			if !sameOrigin(e.URL) {
				return
			}
			go func() {
				if !reachable() {
					waitForServer(e.URL)
				}
			}()
		})
		// target=_blank and window.open: ade's own pages stay in the window,
		// everything else goes to the browser.
		page.SetWindowOpenHandler(func(req mygo.WindowOpenRequest) *mygo.WindowOptions {
			if sameOrigin(req.URL) {
				_ = page.LoadURL(req.URL)
			} else if req.UserInitiated {
				go mygo.Shell.OpenExternal(req.URL)
			}
			return nil
		})
		// A plain link to another site goes to the browser too.
		page.OnWillNavigate(func(e *mygo.NavigateEvent) {
			if sameOrigin(e.URL) || !e.UserInitiated {
				return
			}
			if u, err := url.Parse(e.URL); err == nil && (u.Scheme == "http" || u.Scheme == "https" || u.Scheme == "mailto") {
				e.PreventDefault()
				go mygo.Shell.OpenExternal(e.URL)
			}
		})
	})

	mygo.App.OnNotificationClick(func(id string) {
		if win == nil {
			return
		}
		win.Restore()
		win.Focus()
		_ = win.Page().LoadURL(origin + "/?thread=" + id)
	})
	mygo.App.OnSecondInstance(func(args []string, dir string) {
		if win != nil {
			win.Restore()
			win.Focus()
		}
	})

	if err := mygo.App.Run(); err != nil {
		log.Fatal(err)
	}
}
