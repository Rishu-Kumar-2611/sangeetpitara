# SangeetPitara 1.1.15

Includes the refined UI, voice chat, replies and hardening shipped in 1.1.14, with a final phone-navigation correction found during public visual verification.

The obsolete room entrance animation retained a transformed containing block. This made fixed phone navigation anchor to the room panel instead of the viewport. The room no longer uses that animation. A browser regression checks the navigation's bottom edge against the viewport in phone portrait sizes, alongside existing landscape, theme, chat and overflow checks.

Android and shared offline assets receive matching version/cache identities: version 1.1.15, versionCode 10115, asset cache 20261108-mehfil2. No database or audio transport change is required.
