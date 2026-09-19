# rcja-soccer-sim Makefile

NAME ?=
ARGS ?=
TAG_VERSION = v$$(date +'%y.%-m')-$$(git rev-parse --short=6 HEAD 2>/dev/null || echo dev)

# ---------------------------------------------------------------------------
# uv helper: try uv (installed at ~/.local/bin/uv or on PATH), fall back to
# plain python3/pip3 with a warning so the build never fails just because uv
# is not installed.
# ---------------------------------------------------------------------------
UV := $(shell command -v uv 2>/dev/null || echo $(HOME)/.local/bin/uv 2>/dev/null || echo "")
define run_python
$(if $(UV),\
	$(UV) run $(1),\
	$(warning uv not found — falling back to python3. Install uv: https://docs.astral.sh/uv/) python3 $(1))
endef
define run_pip
$(if $(UV),\
	$(UV) pip $(1),\
	$(warning uv not found — falling back to pip3. Install uv: https://docs.astral.sh/uv/) pip3 $(1))
endef

.PHONY: help install link \
	build build-all build-bin build-py build-viewer build-referee build-practice build-workspace build-site \
	dev-viewer dev-referee dev-practice dev-workspace dev-site \
	serve serve-agents serve-referee practice league league-setup arena capacity \
	play play-violet play-lime \
	match ladder bench check-name draw tournament-serve table \
	check typecheck test test-watch check-py clean clean-data clean-all \
	systemd-user update tag

help:
	@echo "\033[1mrcja-soccer-sim\033[0m"
	@echo ""
	@echo "\033[36mSetup & Build:\033[0m"
	@echo "  make install                Install dependencies (bun install + uv sync)"
	@echo "  make link                   Expose 'rcja-soccer-sim' on PATH (bun link)"
	@echo "  make build                  Build all web frontends (viewer, referee, practice, workspace, site)"
	@echo "  make build-bin              Build standalone binary (dist/bin/rcja-soccer-sim)"
	@echo "  make build-py               Build Python package wheels and sdist (dist/python/)"
	@echo "  make build-all              Build all frontends, standalone binary, and python wheel"
	@echo "  make build-<target>         Build single frontend (viewer | referee | practice | workspace | site)"
	@echo "  make dev-<target>           Start Vite dev server (viewer | referee | practice | workspace | site)"
	@echo ""
	@echo "\033[36mServers & Venue Operations:\033[0m"
	@echo "  make league-setup           Initialize a new league and create the first admin [ARGS=...]"
	@echo "  make league                 Run full venue league server with public portal [ARGS=...]"
	@echo "  make serve                  Run match server with reference agents [ARGS=...]"
	@echo "  make serve-agents           Run match server, waiting for 4 robot programs [ARGS=...]"
	@echo "  make serve-referee          Run match server with referee console [ARGS=...]"
	@echo "  make practice               Open interactive practice field [ARGS=...]"
	@echo "  make arena                  Run arena worker [ARGS=...]"
	@echo "  make capacity               Measure server match capacity [ARGS=...]"
	@echo "  make systemd-user           Install and configure systemd user service"
	@echo "  make update                 Pull latest changes, rebuild, and restart systemd service"
	@echo "  make tag                    Create release tag (vYY.M-hash)"
	@echo ""
	@echo "\033[36mExample Robots:\033[0m"
	@echo "  make play                   Start striker+goalie for both sides (after serve-agents)"
	@echo "  make play-violet            Start example robots for violet only"
	@echo "  make play-lime              Start example robots for lime only"
	@echo ""
	@echo "\033[36mTournaments & Benchmarks:\033[0m"
	@echo "  make match                  Play one headless match and print result [ARGS=...]"
	@echo "  make ladder                 Play all built-in bots round-robin [ARGS=...]"
	@echo "  make bench                  Measure robot performance against reference team [ARGS=...]"
	@echo "  make draw NAME=...          Generate tournament fixture list [ARGS=...]"
	@echo "  make tournament-serve NAME=... Play through tournament fixtures [ARGS=...]"
	@echo "  make table NAME=...         Print current tournament standings [ARGS=...]"
	@echo ""
	@echo "\033[36mQuality & Testing:\033[0m"
	@echo "  make check                  Run typecheck and python compilation check"
	@echo "  make typecheck              tsc --build (project references)"
	@echo "  make check-py               Validate python examples and library syntax"
	@echo "  make test                   Run test suite (python unittest + bun test)"
	@echo "  make test-py                Run the machine/ module's python unittest suite"
	@echo "  make test-watch             Run test suite in watch mode"
	@echo "  make clean                  Remove build artifacts and scratch data"
	@echo "  make clean-data             Remove local repository test state (rm -rf data)"
	@echo "  make clean-all              Remove both build artifacts and test state"

## --- Setup & Build ---
install:
	bun install
	@if command -v uv >/dev/null 2>&1 || [ -x "$(HOME)/.local/bin/uv" ]; then \
		echo "\033[36mSyncing Python workspace with uv...\033[0m"; \
		$${UV:-uv} sync; \
	else \
		echo "\033[33mWarning: uv not found — skipping Python sync. Install uv: https://docs.astral.sh/uv/\033[0m"; \
	fi

link:
	bun link

build: build-viewer build-referee build-practice build-workspace build-site

build-all: build build-bin

build-bin:
	@VER=$$(bun -e "import { getVersion } from './packages/server/src/infra/version'; console.log(getVersion())" 2>/dev/null || echo "dev"); \
	bun build --compile --define APP_VERSION="\"$$VER\"" \
		--outfile=dist/bin/rcja-soccer-sim ./packages/server/src/infra/cli.ts

build-viewer:
	bun run --filter '@rcja/viewer' build

build-referee:
	bun run --filter '@rcja/referee' build

build-practice:
	bun run --filter '@rcja/practice' build

build-workspace:
	bun run --filter '@rcja/workspace' build

build-site:
	bun run --filter '@rcja/site' build

dev-viewer:
	bun run --filter '@rcja/viewer' dev

dev-referee:
	bun run --filter '@rcja/referee' dev

dev-practice:
	bun run --filter '@rcja/practice' dev

dev-workspace:
	bun run --filter '@rcja/workspace' dev

dev-site:
	bun run --filter '@rcja/site' dev

## --- Servers & Venues ---
serve: build-viewer
	bun packages/server/src/infra/cli.ts serve $(if $(ARGS),-- $(ARGS))

serve-agents: build-viewer
	bun packages/server/src/infra/cli.ts serve -- --agents $(ARGS)

serve-referee: build-viewer build-referee
	bun packages/server/src/infra/cli.ts serve -- --referee $(ARGS)

practice: build-viewer build-practice
	bun packages/server/src/infra/cli.ts practice $(ARGS)

league-setup:
	bun packages/server/src/infra/cli.ts league-setup $(ARGS)

league: build-viewer build-referee build-practice build-workspace build-site
	bun packages/server/src/infra/cli.ts league $(if $(NAME),--name "$(NAME)") $(ARGS)

arena:
	bun packages/server/src/infra/cli.ts arena $(ARGS)

capacity:
	bun packages/server/src/infra/cli.ts capacity $(ARGS)

systemd-user: build
	bun packages/server/src/infra/cli.ts service install $(if $(NAME),--name "$(NAME)") $(ARGS)

update:
	bun packages/server/src/infra/cli.ts upgrade

tag:
	@TAG=$$(echo $(TAG_VERSION)); \
	git tag -a "$$TAG" -m "Release $$TAG"; \
	echo "\033[32mCreated tag $$TAG\033[0m"; \
	echo "Push it with: git push origin $$TAG"

## --- Robot Control ---
play:
	cd python && PYTHONPATH=. python3 examples/play.py

play-violet:
	cd python && PYTHONPATH=. python3 examples/play.py --only violet

play-lime:
	cd python && PYTHONPATH=. python3 examples/play.py --only lime

## --- Simulation & Tournaments ---
match:
	bun packages/server/src/infra/cli.ts match $(ARGS)

ladder:
	bun packages/server/src/infra/cli.ts ladder $(ARGS)

bench:
	bun packages/server/src/infra/cli.ts bench $(ARGS)

check-name:
	@if [ -z "$(NAME)" ]; then \
		echo "\033[31mError: NAME is required. Example: make $(MAKECMDGOALS) NAME=state-round-1\033[0m" >&2; \
		exit 1; \
	fi

draw: check-name
	bun packages/server/src/infra/cli.ts draw --name "$(NAME)" $(ARGS)

tournament-serve: check-name build-viewer
	bun packages/server/src/infra/cli.ts tournament --name "$(NAME)" $(ARGS)

table: check-name
	bun packages/server/src/infra/cli.ts table --name "$(NAME)" $(ARGS)

build-py:
	mkdir -p dist/python
	@if command -v uv >/dev/null 2>&1 || [ -x "$(HOME)/.local/bin/uv" ]; then \
		echo "\033[36mBuilding Python package with uv...\033[0m"; \
		$${UV:-$$(command -v uv || echo $(HOME)/.local/bin/uv)} build python/ --wheel --sdist --out-dir dist/python/; \
	else \
		echo "\033[33mWarning: uv not found — falling back to python3 -m build. Install uv: https://docs.astral.sh/uv/\033[0m"; \
		python3 -m build python/ --wheel --sdist --outdir dist/python/; \
	fi

## --- Verification & Quality ---
check: typecheck check-py

typecheck:
	bun tsc --build

check-py:
	python3 -m py_compile python/rcja_soccer/*.py python/machine/*.py python/utime.py python/examples/*.py python/*.py

test: test-py
	bun test --cwd packages/server

test-py:
	@if command -v uv >/dev/null 2>&1 || [ -x "$(HOME)/.local/bin/uv" ]; then \
		echo "\033[36mRunning Python tests with uv...\033[0m"; \
		$${UV:-$$(command -v uv || echo $(HOME)/.local/bin/uv)} run python3 -m unittest discover -s python/tests -v; \
	else \
		echo "\033[33mWarning: uv not found — running tests with system python3. Install uv: https://docs.astral.sh/uv/\033[0m"; \
		python3 -m unittest discover -s python/tests -v; \
	fi

test-watch:
	bun test --watch --cwd packages/server

clean:
	rm -rf dist dist-*
	rm -rf python/build python/dist python/*.egg-info
	rm -f scratch/*.jsonl scratch/locframes.json
	rm -rf scratch/frames scratch/rotframes
	find . -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true

clean-data:
	rm -rf data

clean-all: clean clean-data
