# Changelog

## [0.4.4](https://github.com/JoshMock/the-agency/compare/vmpi-v0.4.3...vmpi-v0.4.4) (2026-09-18)


### Bug Fixes

* drop non-string entries from settings.packages before treating the rest as strings ([#121](https://github.com/JoshMock/the-agency/issues/121)) ([0280b93](https://github.com/JoshMock/the-agency/commit/0280b93a40c8b71249f42031248f8f6a58b899ee))
* project config explorer must not search global dirs ([#123](https://github.com/JoshMock/the-agency/issues/123)) ([ca86817](https://github.com/JoshMock/the-agency/commit/ca868177f9bf64b8a04c79301a517a4d3df19cd5))

## [0.4.3](https://github.com/JoshMock/the-agency/compare/vmpi-v0.4.2...vmpi-v0.4.3) (2026-09-16)


### Bug Fixes

* drop guest-planted symlinks during session sync ([#111](https://github.com/JoshMock/the-agency/issues/111)) ([12dc363](https://github.com/JoshMock/the-agency/commit/12dc3630d5d6d64276f4c498c0863dc2e6a0d506))

## [0.4.2](https://github.com/JoshMock/the-agency/compare/vmpi-v0.4.1...vmpi-v0.4.2) (2026-09-11)


### Bug Fixes

* enforce minimum VMPI_MEMORY of 512 MiB ([#108](https://github.com/JoshMock/the-agency/issues/108)) ([f0a5b35](https://github.com/JoshMock/the-agency/commit/f0a5b35ce3e5edfeeda8a3e011305d9039ca8770))
* support macOS (Apple Silicon) hosts ([#97](https://github.com/JoshMock/the-agency/issues/97)) ([462fcb6](https://github.com/JoshMock/the-agency/commit/462fcb641ed50cd00ddf96559dbc25ed054a7b58))
* use die() for unsupported host architecture ([#106](https://github.com/JoshMock/the-agency/issues/106)) ([3fdfcf3](https://github.com/JoshMock/the-agency/commit/3fdfcf3eb0efb496dc5e4325225568330af212f0))

## [0.4.1](https://github.com/JoshMock/the-agency/compare/vmpi-v0.4.0...vmpi-v0.4.1) (2026-05-20)


### Bug Fixes

* correct OpenRouter hostname ([3f5225b](https://github.com/JoshMock/the-agency/commit/3f5225bfc22966f90f2393f4470686ddf94bdc05))

## [0.4.0](https://github.com/JoshMock/the-agency/compare/vmpi-v0.3.0...vmpi-v0.4.0) (2026-05-15)


### Features

* add llama.cpp support ([#80](https://github.com/JoshMock/the-agency/issues/80)) ([8cf1a8a](https://github.com/JoshMock/the-agency/commit/8cf1a8add840063bf3bba2438db977b48e6b2c9e))
* log all blocked hostnames, missing executables when --debug flag is on ([#68](https://github.com/JoshMock/the-agency/issues/68)) ([23e21c3](https://github.com/JoshMock/the-agency/commit/23e21c3a3b791ed3286e757d5b52399c3fe0e18c))
* mount directories ([#81](https://github.com/JoshMock/the-agency/issues/81)) ([b315796](https://github.com/JoshMock/the-agency/commit/b315796ce9fe995c8ace108374dfbbcd55fa42be))
* post-setup hooks ([#70](https://github.com/JoshMock/the-agency/issues/70)) ([1aac153](https://github.com/JoshMock/the-agency/commit/1aac153f5673179039eded86921643bd1f695b7b))
* stop prereq check ([#79](https://github.com/JoshMock/the-agency/issues/79)) ([a4fd341](https://github.com/JoshMock/the-agency/commit/a4fd341e05a491a257fa14a1af6940e6fa760848))


### Bug Fixes

* add darwin to supported engines ([#83](https://github.com/JoshMock/the-agency/issues/83)) ([5031f23](https://github.com/JoshMock/the-agency/commit/5031f23820bc8434b320f08b2b7607aa3695479c))
* update Pi package location ([#82](https://github.com/JoshMock/the-agency/issues/82)) ([0196312](https://github.com/JoshMock/the-agency/commit/0196312c30f32dfb726dfc37e4b981e4d265d196))

## [0.3.0](https://github.com/JoshMock/the-agency/compare/vmpi-v0.2.0...vmpi-v0.3.0) (2026-04-29)


### Features

* add openrouter support to vmpi ([#63](https://github.com/JoshMock/the-agency/issues/63)) ([6a50782](https://github.com/JoshMock/the-agency/commit/6a50782299d00f54f8d5ca96681cc254302a3199))


### Bug Fixes

* adjust TTY output so sleeping QEMU process does not lock TUI ([#66](https://github.com/JoshMock/the-agency/issues/66)) ([d0e5787](https://github.com/JoshMock/the-agency/commit/d0e57876fdc64fde4234ab1927695ad67f9887e5))
* force TERM=xterm-256color ([#65](https://github.com/JoshMock/the-agency/issues/65)) ([cb4a43c](https://github.com/JoshMock/the-agency/commit/cb4a43c79b4af423dd9f68dcbb48e0f9a728519b))

## [0.2.0](https://github.com/JoshMock/the-agency/compare/vmpi-v0.1.5...vmpi-v0.2.0) (2026-04-17)


### Features

* secret passthrough support ([#60](https://github.com/JoshMock/the-agency/issues/60)) ([576d570](https://github.com/JoshMock/the-agency/commit/576d570541a280e074b27db73be7b61e8a4366f9))


### Bug Fixes

* avoid EXDEV error on session sync ([#62](https://github.com/JoshMock/the-agency/issues/62)) ([af7b439](https://github.com/JoshMock/the-agency/commit/af7b439ec2e87dd751da802ed773640fa1494b4f))

## [0.1.5](https://github.com/JoshMock/the-agency/compare/vmpi-v0.1.4...vmpi-v0.1.5) (2026-04-17)


### Bug Fixes

* preserve session timestamps to make --continue deterministic ([#57](https://github.com/JoshMock/the-agency/issues/57)) ([ba06640](https://github.com/JoshMock/the-agency/commit/ba066403990537ca3d5a1e77338f875a4665e633))

## [0.1.4](https://github.com/JoshMock/the-agency/compare/vmpi-v0.1.3...vmpi-v0.1.4) (2026-04-16)


### Bug Fixes

* adjust session path sync to ensure consistency ([#55](https://github.com/JoshMock/the-agency/issues/55)) ([67c6998](https://github.com/JoshMock/the-agency/commit/67c699817fc325bf139647c14c3fbf2c9539777a))

## [0.1.3](https://github.com/JoshMock/the-agency/compare/vmpi-v0.1.2...vmpi-v0.1.3) (2026-04-16)


### Bug Fixes

* set repository URL ([#53](https://github.com/JoshMock/the-agency/issues/53)) ([fe4fb9d](https://github.com/JoshMock/the-agency/commit/fe4fb9d1a0f275edcf30186d5a7ef75ee12b857e))

## [0.1.2](https://github.com/JoshMock/the-agency/compare/vmpi-v0.1.1...vmpi-v0.1.2) (2026-04-16)


### Bug Fixes

* bad nom publish configs ([#51](https://github.com/JoshMock/the-agency/issues/51)) ([336e323](https://github.com/JoshMock/the-agency/commit/336e323ca72a8f02d1f140e87fff4763772dcf3b))

## [0.1.1](https://github.com/JoshMock/the-agency/compare/vmpi-v0.1.0...vmpi-v0.1.1) (2026-04-16)


### Bug Fixes

* ensure config search looks up the file tree ([#50](https://github.com/JoshMock/the-agency/issues/50)) ([c7d3147](https://github.com/JoshMock/the-agency/commit/c7d3147bf8840dd3eefb04b43a45850e3fe66dc8))
* missing build files ([#48](https://github.com/JoshMock/the-agency/issues/48)) ([39f89bd](https://github.com/JoshMock/the-agency/commit/39f89bde4099e9203b1c5d1c3beb204f23c13630))
