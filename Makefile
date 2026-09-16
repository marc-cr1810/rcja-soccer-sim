# rcja-soccer-sim Makefile

NAME ?=
ARGS ?=

.PHONY: help install link \
	build build-all build-bin build-viewer build-referee build-practice build-workspace build-site \
	dev-viewer dev-referee dev-practice dev-workspace dev-site \
	serve serve-agents serve-referee practice league arena capacity \
	play play-violet play-lime \
	match ladder bench check-name draw tournament-serve table \
	check typecheck test test-watch check-py clean

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
	@echo "\033[36mServers & Practice:\033[0m"
	@echo "  make serve                  Run match server with reference agents [ARGS=...]"
	@echo "  make serve-agents           Run match server, waiting for 4 robot programs [ARGS=...]"
	@echo "  make serve-referee          Run match server with referee console [ARGS=...]"
	@echo "  make practice               Open interactive practice field [ARGS=...]"
	@echo "  make league                 Run full venue league server with public portal [ARGS=...]"
	@echo "  make arena                  Run arena worker [ARGS=...]"
	@echo "  make capacity               Measure server match capacity [ARGS=...]"
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

## --- Setup & Build ---
install:
	bun install

link:
	bun link

build: build-viewer build-referee build-practice build-workspace build-site

build-all: build build-bin

build-bin:
	bun run build:bin

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
	bun run serve $(if $(ARGS),-- $(ARGS))

serve-agents: build-viewer
	bun run serve -- --agents $(ARGS)

serve-referee: build-viewer build-referee
	bun run serve -- --referee $(ARGS)

practice: build-viewer build-practice
	bun run serve -- practice $(ARGS)

league: build-viewer build-referee build-practice build-workspace build-site
	bun run serve -- league $(ARGS)

arena:
	bun run serve -- arena $(ARGS)

capacity:
	bun run serve -- capacity $(ARGS)

## --- Robot Control ---
play:
	cd python && PYTHONPATH=. python3 examples/play.py

play-violet:
	cd python && PYTHONPATH=. python3 examples/play.py --only violet

play-lime:
	cd python && PYTHONPATH=. python3 examples/play.py --only lime

## --- Simulation & Tournaments ---
match:
	bun run serve -- match $(ARGS)

ladder:
	bun run serve -- ladder $(ARGS)

bench:
	bun run serve -- bench $(ARGS)

check-name:
	@if [ -z "$(NAME)" ]; then \
		echo "\033[31mError: NAME is required. Example: make $(MAKECMDGOALS) NAME=state-round-1\033[0m" >&2; \
		exit 1; \
	fi

draw: check-name
	bun run serve -- draw --name "$(NAME)" $(ARGS)

tournament-serve: check-name build-viewer
	bun run serve -- tournament --name "$(NAME)" $(ARGS)

table: check-name
	bun run serve -- table --name "$(NAME)" $(ARGS)

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
	rm -rf dist dist-bin dist-viewer dist-referee dist-practice dist-workspace dist-site
	rm -f scratch/*.jsonl scratch/locframes.json
	rm -rf scratch/frames scratch/rotframes
	find . -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true
