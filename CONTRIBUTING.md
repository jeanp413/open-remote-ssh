# Contributing

:+1::tada: First off, thanks for taking the time to contribute! :tada::+1:

This document is intended for anyone considering opening an **issue**, **discussion** or **pull request**.

#### Table Of Contents

- [Code of Conduct](#code-of-conduct)
- [Use of AI](#use-of-ai)
- [I have a bug! / Something isn't working](#i-have-a-bug--something-isnt-working)
- [I have an idea for a feature](#i-have-an-idea-for-a-feature)
- [I want to make changes](#i-want-to-make-changes)
- [Spread the word](#spread-the-word)

## Code of Conduct

This project and everyone participating in it is governed by the [Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code.

## Use of AI

We welcome use of AI tools to help draft discussions, issues, or code, but please follow these rules:

- Use AI tools responsibly and disclose their use.
- Ensure all content passes a human review for authenticity and quality.
- Be concise. Do not write verbose discussions, issues or PR.

Discussions, issues or PR that consist solely of unvetted AI outputs may be closed at the maintainer's discretion.

## I have a bug! / Something isn't working

First, search the issue tracker for similar issues.<br />
Tip: also search for [closed issues]; your issue might have already been fixed!

> [!NOTE]
>
> If there is an _open_ issue that matches your problem, **please do not comment on it unless you have valuable insight to add**.
>
> Use the emoji reactions on issues, which are a visible yet non-disruptive way to show your support.

If your issue hasn't been reported already, open a new issue and make sure to fill in the template **completely**. They are vital for maintainers to figure out important details about your setup.

[closed issues]: https://github.com/jeanp413/open-remote-ssh/issues?q=is%3Aissue%20state%3Aclosed

## I have an idea for a feature

Like bug reports, first search through issues and try to find if your feature has already been requested. Otherwise, open a new issue.

## I want to make changes

Small and trivial improvements can be submitted without any issues.

**For non-trivial changes**, pull requests should be associated with a **previously accepted issue**.<br />
It's always better to ask for prior approval and discuss what you want to do before doing it.

Discussing that you want to do something doesn't put any obligations on you. If you don't want to start the discussion just because you're afraid that you won't do it. Don't be afraid!

> [!NOTE]
>
> **Pull requests are NOT a place to discuss feature design.** Please do not open a WIP pull request to discuss a feature. Instead, use an issue and link to your branch.

### Code hygiene

When implementing features and bug fixes, please stick to the structure of the codebase as much as possible and do not take this as an opportunity to do some "refactoring along the way".

Similarly:
- **Make your changes** following our code standards
- **Test your changes** thoroughly
- **Update documentation** if needed
- **Commit your changes** with clear, descriptive commit messages

### Testing

```bash
npm run test:images
npm run test
```

### Version

Do not bump the version number.

### CHANGELOG.md

Do not add an entry to the `CHANGELOG.md` file.

## Spread the word

Do you like the project?

* Spread the word in social networks!
* Talk about it to your colleagues and friends
* Write a blogpost
* Record a YouTube video
