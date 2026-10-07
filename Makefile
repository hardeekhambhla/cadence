PYTHON := .venv/bin/python

.PHONY: run test install restart

# Dev server on :8430 (reachable over Tailscale too).
run:
	$(PYTHON) app.py

# Engine + API checks on synthetic media (generates tests/assets on first run).
test:
	$(PYTHON) tests/smoke.py && CADENCE_DATA=$$(mktemp -d) $(PYTHON) tests/api_smoke.py && $(PYTHON) tests/resize_check.py && $(PYTHON) tests/dates_check.py && $(PYTHON) tests/norepeat_check.py && $(PYTHON) tests/resync_check.py

install:
	sudo cp systemd/cadence.service /etc/systemd/system/cadence.service
	sudo systemctl daemon-reload
	sudo systemctl enable --now cadence.service
	systemctl status cadence.service --no-pager

restart:
	sudo systemctl restart cadence.service
	systemctl status cadence.service --no-pager
