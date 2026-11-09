# Work Mate

A phone app for the work jobs that are a pain to track on paper. It runs offline,
installs to your home screen, and **keeps all data on your phone**. Nothing is
uploaded anywhere.

| Tab | What it does |
| --- | --- |
| **Assets** | Record **odometer, engine hours and PTO hours** for each asset. Each meter has an **N/A** tick box, which is ticked for you when the asset doesn't have that meter. A **weekly round** checklist shows which assets are done and which are still to do. Copy the week straight into the management spreadsheet, or share/download it as CSV. It warns you if a reading is lower than the last one. |
| **Hours** | Log each shift. The date defaults to today. Set start and finish with **scroll wheels** (hour, then minute). Night shifts that finish after midnight are handled. You can add an unpaid break and **allowances**: one-off amounts, or an hourly rate × the day's hours. A **weekly breakdown** and the last 8 weeks' totals let you check your payslip. |
| **Vacuum** | Hose board: **tap a hose to turn it green (on) or red (off)**. Hoses are grouped under the vacuum unit they're tethered to. Each group shows how long that vacuum has been **running non-stop**, and each hose shows its own running clock. If you tap by mistake, use Undo. **Stats** has day/week/month views: times turned on/off, run hours per hose and per vacuum, a daily chart, a timeline, and a run log you can correct. |
| **Sentry** | Timesheet-style log for **sentry, tank cleaning or any job type**, at **code-named locations**. Tap **Start now** to run a live timer, then **Finish now**, or enter start/finish with the wheels. Shows weekly totals by job type and location. |
| **Manage** | Edit the lists that fill every dropdown: **assets, hoses, allowances, locations, job types**. Also holds settings (first day of the week, 12/24-hour time, minute steps), **backup/restore** and CSV exports. |

## Putting it on your phone

The app is a set of static files, so any static web host works. The free and easy option is **GitHub Pages**:

1. On GitHub, go to **Settings → Pages**.
2. Under *Build and deployment*, choose **Deploy from a branch**. Pick the branch that has this code
   (e.g. `main`, or `claude/work-management-app-q4c733` until it's merged), choose **`/ (root)`**, and click **Save**.
3. After a minute or so the app is live at `https://kaddakaman.github.io/Work/`.
4. Open that link on your phone:
   - **iPhone:** in **Safari**, tap Share, then **Add to Home Screen**.
   - **Android:** in **Chrome**, open the ⋮ menu and tap **Install app** (or *Add to Home screen*).

After the first load it works with no signal.

> The code is public, but your data isn't. Readings, hours, locations and so on
> are saved only in the phone's storage, so don't put anything sensitive in the code itself.

## Backups

Because the data lives only on the phone, losing the phone or deleting the app
deletes the data too. Go to **Manage → Settings & backup → Download backup**
now and then, and save the file somewhere safe (email it to yourself, or put it in a cloud drive).
**Restore backup** loads that file onto any phone, including a new one.

## Running it locally

```bash
npm start          # serves the app at http://localhost:8080
npm test           # unit tests for the time / allowance / vacuum maths
```

There are no dependencies and no build step. It's plain HTML, CSS and JavaScript modules.

## Project layout

```
index.html               app shell
css/app.css              all styles (light + dark)
js/app.js                tab navigation, routing, live timers, service worker
js/store.js              local storage, backup/restore
js/util.js               date/time/format helpers
js/lib/calc.js           hours, allowances, vacuum run-time maths (unit tested)
js/components/timepicker.js   scroll-wheel time picker
js/views/*.js            one file per tab
sw.js                    offline cache
tests/                   node --test unit tests
```

## Releasing changes

The service worker serves the cached app first and updates it in the background,
so a new version shows up the **second** time the app is opened after a deploy.
If you add or rename files, also add them to `FILES` in `sw.js` and bump `VERSION`.
