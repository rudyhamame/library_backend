# RH Stream backend service

The backend runs as the current Linux user's `systemd` service on port `8787`.

Useful commands:

```bash
systemctl --user status rh-stream-backend.service
systemctl --user restart rh-stream-backend.service
journalctl --user -u rh-stream-backend.service -f
```

The service reads secrets and runtime settings from `backend/.env`. Its Roku/LAN
address is `http://192.168.68.60:8787`.

The user service starts automatically when the user session starts. To start it
at boot before login, an administrator can enable lingering once:

```bash
sudo loginctl enable-linger rudy
```
