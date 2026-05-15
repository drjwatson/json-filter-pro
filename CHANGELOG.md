# Changelog

All notable changes to this project are documented in this file.

## [0.1.10] - 2026-05-15

### Fixed

- Fixed Output step behavior in **Include Keys** mode so selecting the first key now adds it correctly.

## [0.1.9] - 2026-05-11

### Added

- Added two filter operators in the Rules UI:
  - contains: generates `regex(<path>, "<search term>", "i")`
  - not contains: generates `regex(<path>, "^(?!.*<search term>).+$", "i")`
- Contains-based operators treat the entered search term as a literal string inside the generated regex pattern.

### Changed

- Updated Filters, Output & Transforms, and Generated Query panels to match Results behavior with sticky headers and panel-level scrolling.
- Widened the filter rule operator select control for better readability.
- Forced each rule's remove button (`x`) to stay aligned at the end of the rule row.
