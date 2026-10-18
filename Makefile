.PHONY: test check run docker-build docker-runtime-build docker-android-build

test:
	npm run check
	npm test

check:
	npm run check

run:
	npm start

docker-build:
	docker build -f Dockerfile.runtime -t roomsound:local .

docker-runtime-build:
	docker build -f Dockerfile.runtime -t roomsound:runtime .

docker-android-build:
	docker build --target android-build -t roomsound-android:local .
