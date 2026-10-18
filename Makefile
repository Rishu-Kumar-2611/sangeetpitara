.PHONY: test check run docker-build

test:
	npm run check
	npm test

check:
	npm run check

run:
	npm start

docker-build:
	docker build -t roomsound:local .
