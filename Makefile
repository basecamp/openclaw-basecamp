.PHONY: all typecheck lint test

all: typecheck lint test

typecheck:
	npm run typecheck

lint:
	npm run lint

test:
	npm test
