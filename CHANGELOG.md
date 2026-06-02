# Change Log

## [1.0]

- Initial release

## [1.4.5]

- Close file after last change

## [0.8.0] (ethansk fork)

- Fix: "go to next change" jumping to the wrong file (or getting stuck) when a file was partially staged / staged-then-edited — such a file appears twice (staged + unstaged) and the position lookup matched by path only, locking onto the wrong copy. Navigation entries are now tagged with their staged/unstaged side, the current side is detected from the active diff, and the matching side is opened.
- New: `shift+alt+z` stages the current file and jumps to the next unstaged file, so you can review-and-stage without clicking the + manually.