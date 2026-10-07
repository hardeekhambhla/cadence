PYTHON := .venv/bin/python

.PHONY: run test install uninstall restart status logs

# Dev server on :8430 (reachable over Tailscale too).
run:
	$(PYTHON) app.py

# Engine + API checks on synthetic media (generates tests/assets on first run).
test:
	$(PYTHON) tests/smoke.py && CADENCE_DATA=$$(mktemp -d) $(PYTHON) tests/api_smoke.py && $(PYTHON) tests/resize_check.py && $(PYTHON) tests/dates_check.py && $(PYTHON) tests/norepeat_check.py && $(PYTHON) tests/resync_check.py

# Installs Cadence as a systemd service. The watchdog (~/watchdog, every 5 min) restarts any enabled service in
# /etc/systemd/system that is down, so this is all it takes to keep Cadence up. Frees :8430 first if a hand-started copy holds it.
install:
	-@lsof -ti :8430 | xargs -r kill
	sudo cp systemd/cadence.service /etc/systemd/system/cadence.service
	sudo systemctl daemon-reload
	sudo systemctl enable --now cadence.service
	systemctl status cadence.service --no-pager

uninstall:
	sudo systemctl disable --now cadence.service
	sudo rm -f /etc/systemd/system/cadence.service
	sudo systemctl daemon-reload

restart:
	sudo systemctl restart cadence.service
	systemctl status cadence.service --no-pager

status:
	systemctl status cadence.service --no-pager -l

logs:
	journalctl -u cadence.service -n 50 --no-pager
