# Convenience wrappers. Everything here is optional — the project opens and runs
# from Xcode with no setup.

SCHEME  ?= Gameplan
PROJECT ?= Gameplan.xcodeproj
DEST    ?= platform=iOS Simulator,name=iPhone 16

.PHONY: help build test open project clean

help:
	@echo "make build    Build the app for the simulator"
	@echo "make test     Run the test suite"
	@echo "make open     Open the project in Xcode"
	@echo "make project  Regenerate Gameplan.xcodeproj from project.yml (needs xcodegen)"
	@echo "make clean    Remove build artifacts"
	@echo ""
	@echo "Override the simulator with: make test DEST='platform=iOS Simulator,name=iPhone 15'"

build:
	xcodebuild build -project $(PROJECT) -scheme $(SCHEME) -destination '$(DEST)' | xcbeautify || \
	xcodebuild build -project $(PROJECT) -scheme $(SCHEME) -destination '$(DEST)'

test:
	xcodebuild test -project $(PROJECT) -scheme $(SCHEME) -destination '$(DEST)'

open:
	open $(PROJECT)

project:
	xcodegen generate

clean:
	xcodebuild clean -project $(PROJECT) -scheme $(SCHEME) || true
	rm -rf build DerivedData
