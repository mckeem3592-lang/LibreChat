# Mission AI Local Acceptance

After the Mac bootstrap has been run, execute:

```bash
zsh ~/.local/share/mission-ai/source/mission-ai/acceptance/check-macos.sh
```

The check is intentionally non-destructive. It verifies:

- Mission AI device and browser credentials exist in macOS Keychain without
  printing them.
- Companion and Code Worker launchd services are loaded.
- Code Worker identity exists.
- Excel/Word/PowerPoint/PDF libraries pass their pinned-version verification.
- Companion is connected outbound to the cloud gateway.
- Chrome extension is paired and connected.
- macOS Accessibility and Screen Recording permissions are available.

It does not click, type, change files, reveal credentials, or change system
privacy settings.
