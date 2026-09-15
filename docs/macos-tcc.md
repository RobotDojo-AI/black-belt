# macOS TCC limits

Full Disk Access cannot be granted from a terminal on macOS 13+.

`sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db"` fails with `attempt to write a readonly database (8)` on macOS Ventura and later — SIP protects TCC.db even from root. There is no programmatic FDA grant path.

Any in-app FDA recovery instruction must use the GUI deeplink:

```bash
open "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"
```

Not a `sqlite3` command.
