# Change Log

## [1.0]

- Initial release

## [1.4.5]

- Close file after last change

## [0.8.0] (ethansk fork)

- Fix: "go to next change" jumping to the wrong file (or getting stuck) when a file was partially staged / staged-then-edited — such a file appeared twice in the navigation list (staged + unstaged) and the lookup locked onto the unreachable staged copy. The list is now de-duplicated to one entry per file.
- New: `shift+alt+z` stages the current file and jumps to the next unstaged file, so you can review-and-stage without clicking the + manually.