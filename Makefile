.PHONY: help install link build build-viewer build-referee dev-viewer dev-referee \
        serve serve-agents serve-referee tournament-serve match ladder bench \
        test test-watch typecheck draw table clean play play-violet play-lime

help:
	@echo "rcja-soccer-sim"
	@echo ""
	@echo "  make install         bun install"
	@echo "  make link            bun link — puts 'rcja-soccer-sim' on your PATH"
	@echo "  make build           build viewer + referee bundles"
	@echo "  make build-bin       build standalone binary (dist/bin/rcja-soccer-sim)"
	@echo "  make dev-viewer      vite dev server for the viewer"
	@echo "  make dev-referee     vite dev server for the referee console"
	@echo ""
	@echo "  make serve           run the match server (reference agents)"
	@echo "  make serve-agents    run the match server, waiting for 4 robot programs"
	@echo "  make serve-referee   run the match server with a referee console"
	@echo "  make play            start the example striker+goalie for both sides"
	@echo "                       (run this in another terminal after serve-agents)"
	@echo "  make play-violet     start the example robots for violet only"
	@echo "  make play-lime       start the example robots for lime only"
	@echo ""
	@echo "  make match           play one match headless and print the result"
	@echo "  make ladder          play every built-in bot against every other"
	@echo "  make bench           measure your robot against the reference team"
	@echo ""
	@echo "  make draw NAME=...   write a tournament fixture list"
	@echo "  make tournament-serve NAME=...  play a draw through"
	@echo "  make table NAME=...  print a tournament's table as it stands"
	@echo ""
	@echo "  make test            run the test suite"
	@echo "  make test-watch      run the test suite in watch mode"
	@echo "  make typecheck       tsc --noEmit"
	@echo "  make clean           remove built viewer/referee bundles"

install:
	bun install

link:
	bun link

build: build-viewer build-referee

build-bin:
	bun run build:bin

build-viewer:
	bun run build:viewer

build-referee:
	bun run build:referee

dev-viewer:
	bun run dev:viewer

dev-referee:
	bun run dev:referee

serve: build-viewer
	bun run serve

serve-agents: build-viewer
	bun run serve -- --agents

serve-referee: build-viewer build-referee
	bun run serve -- --referee

play:
	cd python && PYTHONPATH=. python3 examples/play.py

play-violet:
	cd python && PYTHONPATH=. python3 examples/play.py --only violet

play-lime:
	cd python && PYTHONPATH=. python3 examples/play.py --only lime

match:
	bun run serve -- match

ladder:
	bun run serve -- ladder

bench:
	bun run serve -- bench

draw:
	bun run serve -- draw --name "$(NAME)"

tournament-serve: build-viewer
	bun run serve -- tournament --name "$(NAME)"

table:
	bun run serve -- table --name "$(NAME)"

test:
	bun test

test-watch:
	bun run test:watch

typecheck:
	bun run typecheck

clean:
	rm -rf dist dist-bin dist-viewer dist-referee dist-practice dist-workspace dist-site
	rm -f scratch/*.jsonl scratch/locframes.json
	rm -rf scratch/frames scratch/rotframes
	find . -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true
