# rcja-soccer-sim Makefile

NAME ?=
ARGS ?=
TAG_VERSION = v$$(date +'%y.%-m')-$$(git rev-parse --short=6 HEAD 2>/dev/null || echo dev)

.PHONY: help install link \
	build build-all build-bin build-viewer build-referee build-practice build-workspace build-site \
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
	@echo "  make install                Install dependencies (bun install)"
	@echo "  make link                   Expose 'rcja-soccer-sim' on PATH (bun link)"
	@echo "  make build                  Build all web frontends (viewer, referee, practice, workspace, site)"
	@echo "  make build-bin              Build standalone binary (dist/bin/rcja-soccer-sim)"
	@echo "  make build-all              Build all frontends and standalone binary"
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
	@echo "  make typecheck              tsc --noEmit"
	@echo "  make check-py               Validate python examples and library syntax"
	@echo "  make test                   Run test suite (bun test)"
	@echo "  make test-watch             Run test suite in watch mode"
	@echo "  make clean                  Remove build artifacts and scratch data"
	@echo "  make clean-data             Remove local repository test state (rm -rf data)"
	@echo "  make clean-all              Remove both build artifacts and test state"

## --- Setup & Build ---
install:
	bun install

link:
	bun link

build: build-viewer build-referee build-practice build-workspace build-site

build-all: build build-bin

build-bin:
	@VER=$$(bun -e "import { getVersion } from './src/version'; console.log(getVersion())" 2>/dev/null || echo "dev"); \
	bun build --compile --define APP_VERSION="\"$$VER\"" --outfile=dist/bin/rcja-soccer-sim ./src/cli.ts

build-viewer:
	bun run build:viewer

build-referee:
	bun run build:referee

build-practice:
	bun run build:practice

build-workspace:
	bun run build:workspace

build-site:
	bun run build:site

dev-viewer:
	bun run dev:viewer

dev-referee:
	bun run dev:referee

dev-practice:
	bun run dev:practice

dev-workspace:
	bun run dev:workspace

dev-site:
	bun run dev:site

## --- Servers & Venues ---
serve: build-viewer
	bun run cli serve $(if $(ARGS),-- $(ARGS))

serve-agents: build-viewer
	bun run cli serve -- --agents $(ARGS)

serve-referee: build-viewer build-referee
	bun run cli serve -- --referee $(ARGS)

practice: build-viewer build-practice
	bun run cli practice $(ARGS)

league-setup:
	bun run cli league-setup $(ARGS)

league: build-viewer build-referee build-practice build-workspace build-site
	bun run cli league $(if $(NAME),--name "$(NAME)") $(ARGS)

arena:
	bun run cli arena $(ARGS)

capacity:
	bun run cli capacity $(ARGS)

systemd-user: build
	bun run cli service install $(if $(NAME),--name "$(NAME)") $(ARGS)

update:
	bun run cli upgrade

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
	bun run cli match $(ARGS)

ladder:
	bun run cli ladder $(ARGS)

bench:
	bun run cli bench $(ARGS)

check-name:
	@if [ -z "$(NAME)" ]; then \
		echo "\033[31mError: NAME is required. Example: make $(MAKECMDGOALS) NAME=state-round-1\033[0m" >&2; \
		exit 1; \
	fi

draw: check-name
	bun run cli draw --name "$(NAME)" $(ARGS)

tournament-serve: check-name build-viewer
	bun run cli tournament --name "$(NAME)" $(ARGS)

table: check-name
	bun run cli table --name "$(NAME)" $(ARGS)

## --- Verification & Quality ---
check: typecheck check-py

typecheck:
	bun run typecheck

check-py:
	python3 -m py_compile python/rcja_soccer/*.py python/examples/*.py python/submit.py

test:
	bun test

test-watch:
	bun run test:watch

clean:
	rm -rf dist dist-*
	rm -f scratch/*.jsonl scratch/locframes.json
	rm -rf scratch/frames scratch/rotframes
	find . -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true

clean-data:
	rm -rf data

clean-all: clean clean-data
