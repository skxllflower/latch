# Latch's native GUI (vpf): the extract window, standalone, replacing the Tauri GUI in gui/. Its own build, outside
# the core's (the latch CLI at the repo root stays the worker the window drives: expand, probe, extract, update).
#
#   cmake -S native -B native/build -A x64 [-DFETCHCONTENT_SOURCE_DIR_VACANTLABS=<vacant-labs checkout>]
#                                           [-DFETCHCONTENT_SOURCE_DIR_WAVDESK=<wavdesk checkout>]
#   cmake --build native/build --config Release     -> native/build/bin/Release/latch-gui.exe
#   macOS: cmake -S native -B native/build -DCMAKE_BUILD_TYPE=Release && cmake --build native/build
#                                                    -> native/build/bin/Latch.app (build/latch, the core, copied in)
#   a release: tools/build-release-native.ps1 (Windows), tools/build-release-native-mac.sh (macOS)
#
# The window itself is WAVdesk's native Latch window (native/shell/latch_window.*, on the shared ExtWindow, the skins, the
# dialogs and the tool runner), compiled from a pinned WAVdesk commit rather than forked: the two apps show one window.
# app/ is what the standalone adds around it (its own window frame, title buttons, skin switch, About, the launch
# arguments, the self-registration, the file log and the bundled tools' first-launch copy) and app/host_stubs.cpp the few WAVdesk-library calls those shared files make.
# vpf and WAVdesk are both pinned to commits (never a branch); for work on either alongside this, point
# FETCHCONTENT_SOURCE_DIR_<NAME> at a local checkout.
cmake_minimum_required(VERSION 3.20)
if(CMAKE_HOST_APPLE AND NOT CMAKE_OSX_DEPLOYMENT_TARGET)
  set(CMAKE_OSX_DEPLOYMENT_TARGET "12.0" CACHE STRING "Minimum macOS (the core's floor)" FORCE)
endif()
project(latch_native C CXX)
if(APPLE)
    enable_language(OBJCXX)   # (the chop library's and the shell's macOS sides: *_mac.mm)
endif()
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/bin)

# the version: tauri.conf.json's, the one the release script and the installer also read (until gui/ retires)
file(READ ${CMAKE_CURRENT_SOURCE_DIR}/../gui/src-tauri/tauri.conf.json LATCH_CONF)
string(REGEX MATCH "\"version\": *\"([0-9.]+)\"" _ "${LATCH_CONF}")
set(LATCH_VERSION ${CMAKE_MATCH_1})
string(REPLACE "." "," LATCH_VERSION_COMMAS "${LATCH_VERSION},0")

include(FetchContent)
FetchContent_Declare(vacantlabs
    GIT_REPOSITORY https://github.com/skxllflower/vacant-labs.git
    GIT_TAG        2c943a6cb1b894b9366cb17081d9468e99801e0c   # vacant-labs main (the Latch chop audit: Etch's 10 ms region floor, VX Native's middle dot and en dash); vacant-labs main (Etch 0.1.2, the manager 0.3.2: the 2026-11-05 round); vacant-labs fix/latch-owner-batch (window popups paint only their dirty rects; Etch WaveView::cornerToggles); vacant-labs main (the 0.1.1 release: the drag-out race, the plugin host helper); vacant-labs main (the Etch bug sweep, the vpf menu fix, the manager's Mac port); vacant-labs main, WAVdesk native's own pin (Etch: the Dev Look is called 1-Bit)
    GIT_SUBMODULES vpf/third_party/clap vpf/third_party/vst3/pluginterfaces
)
FetchContent_Declare(wavdesk
    GIT_REPOSITORY https://github.com/skxllflower/wavdesk.git
    GIT_TAG        f076ea57c15c9be4c2d6a13433c5f0dd719636a9   # wavdesk main (the Latch chop audit: confirmQuit, the bar fitting its width, keys whatever has focus, temp folders off the UI thread; its vacant-labs pin 2c943a6c); wavdesk main (0.3.2: the Latch chop audit fixes, the tree paste, its vacant-labs pin af95bf99); wavdesk fix/latch-owner-batch (the Latch round: chop cookies + tool log, one-pass chop wave, VX / Focused chop UI; buttons measured as drawn); wavdesk main (0.3.1, its vacant-labs pin a2990c99); wavdesk main (ExtWindow::macButtons, the scrolled rules cut to their column); wavdesk main (its vacant-labs pin 7895084e); wavdesk main (the Mac shell merged in) (macOS: the own bundle's coredist core, never the GUI itself; Command+Enter), on feat/native-shell (--setup's verbs under HKCU, not the HKLM root; the Manager --setup / --uninstall; the Latch hooks merged in: enqueue, thumbnail / fold-out hooks, the chop library, the row icons' gap, std-handle-only inheritance, drop / addOutput / Backspace / local lengths, chop folders / resume / channel split, region drag-out, video controls, ExtWindow tooltips + Tauri's tip texts, parity round 2, one-file drop; the "1-Bit" look label, vacant-labs 030d8d34; VX menus hover green)
    GIT_SUBMODULES ""
)
set(JSON_BuildTests OFF CACHE INTERNAL "")
set(JSON_Install    OFF CACHE INTERNAL "")
FetchContent_Declare(nlohmann_json
    GIT_REPOSITORY https://github.com/nlohmann/json.git
    GIT_TAG        v3.11.3
    GIT_SHALLOW    TRUE
)
foreach(dep vacantlabs wavdesk)
    FetchContent_GetProperties(${dep})
    if(NOT ${dep}_POPULATED)
        FetchContent_Populate(${dep})
    endif()
endforeach()
FetchContent_MakeAvailable(nlohmann_json)
set(VPF_BUILD_TESTS OFF CACHE BOOL "" FORCE)
add_subdirectory(${vacantlabs_SOURCE_DIR}/vpf ${CMAKE_BINARY_DIR}/vpf)
# Etch (the chop window's waveform, regions and sound: etch_ui) and WAVdesk's chop library over it (wdn_latch_chop,
# native/chop/README.md in the pinned commit). ETCH_DR_LIBS=PRIVATE as WAVdesk builds it; EXCLUDE_FROM_ALL: only what
# Latch links is built (not Etch's own plugins and app)
set(ETCH_DR_LIBS PRIVATE CACHE STRING "" FORCE)
add_subdirectory(${vacantlabs_SOURCE_DIR}/plugins/etch ${CMAKE_BINARY_DIR}/etch EXCLUDE_FROM_ALL)
include(${wavdesk_SOURCE_DIR}/native/chop/latch_chop.cmake)

# WAVdesk's shell files the window is made of (each one unchanged; native/shell in the pinned commit)
set(WD ${wavdesk_SOURCE_DIR}/native/shell)
set(LATCH_SHARED_SOURCES
    ${WD}/latch_window.cpp ${WD}/ext_window.cpp ${WD}/external_tools.cpp
    ${WD}/look.cpp ${WD}/skin.cpp ${WD}/skin_focused.cpp ${WD}/skin_vx.cpp ${WD}/skin_zen.cpp
    ${WD}/dialog_window.cpp ${WD}/popup_motion.cpp ${WD}/window_place.cpp ${WD}/window_fit.cpp
    ${WD}/ui_state.cpp ${WD}/settings_store.cpp ${WD}/core_process.cpp ${WD}/dev_run.cpp
    ${WD}/menus.cpp ${WD}/context_menu.cpp ${WD}/commands.cpp)
set(LATCH_APP_SOURCES app/main.cpp app/latch_app.cpp app/app_icon.cpp app/about_window.cpp app/host_stubs.cpp app/self_register.cpp app/setup_cli.cpp app/app_log.cpp
    app/player.cpp app/tool_paths.cpp app/settings_window.cpp app/tauri_import.cpp app/audio_out.cpp app/thumbs.cpp)

if(APPLE)
    set(LATCH_EXE_NAME Latch)        # (Latch.app, as the Tauri bundle was named)
else()
    set(LATCH_EXE_NAME latch-gui)    # (the Tauri exe name: the installer, the uninstall key and WAVdesk look for it)
endif()
vpf_add_standalone_app(latch_gui NAME ${LATCH_EXE_NAME} BUNDLE_ID com.vacantsystems.latch VERSION ${LATCH_VERSION}
    SOURCES ${LATCH_APP_SOURCES} ${LATCH_SHARED_SOURCES}
    PLIST ${CMAKE_CURRENT_SOURCE_DIR}/app/Info.plist.in
    ICON ${CMAKE_CURRENT_SOURCE_DIR}/../gui/src-tauri/icons/icon.icns
    WIN_RC ${CMAKE_CURRENT_BINARY_DIR}/latch_gui.rc)
target_include_directories(latch_gui PRIVATE ${WD} ${CMAKE_CURRENT_SOURCE_DIR}/compat)
target_link_libraries(latch_gui PRIVATE vpf::app nlohmann_json::nlohmann_json wdn_latch_chop)
target_compile_definitions(latch_gui PRIVATE LATCH_VERSION="${LATCH_VERSION}")
# the VX skin's packs, embedded as WAVdesk embeds them (skin_vx.cpp reads kWavdeskVx)
file(GLOB LATCH_VX_FILES CONFIGURE_DEPENDS ${wavdesk_SOURCE_DIR}/native/assets/vx/*.json ${wavdesk_SOURCE_DIR}/native/assets/vx/*.pack)
vpf_embed_assets(latch_gui SYMBOL kWavdeskVx FILES ${LATCH_VX_FILES})
# the app's own icon picture (the 1-Bit title strip, drawn in its ink: app_icon.cpp)
vpf_embed_assets(latch_gui SYMBOL kLatchIcon FILES ${CMAKE_CURRENT_SOURCE_DIR}/../gui/src/assets/app-icon.png)
if(WIN32)
    set(LATCH_ICON ${CMAKE_CURRENT_SOURCE_DIR}/../gui/src-tauri/icons/icon.ico)
    configure_file(app/latch_gui.rc.in ${CMAKE_CURRENT_BINARY_DIR}/latch_gui.rc @ONLY)
    # the UTF-8 active code page: the CRT opens UTF-8 paths as such (the core binary's pair)
    target_sources(latch_gui PRIVATE app/latch_gui.manifest)
    target_compile_definitions(latch_gui PRIVATE UNICODE _UNICODE)
    target_link_libraries(latch_gui PRIVATE shell32 ole32 urlmon)
elseif(APPLE)
    # the shell's macOS OS calls (context_menu.h's os::openPath and the rest: Finder, the window frames)
    target_sources(latch_gui PRIVATE ${WD}/os_shell_mac.mm)
    set_source_files_properties(${WD}/os_shell_mac.mm PROPERTIES COMPILE_OPTIONS -fobjc-arc)
    target_link_libraries(latch_gui PRIVATE "-framework Foundation" "-framework AppKit" "-framework CoreServices" "-framework IOKit")
    # the latch CLI into the bundle after every build (app/bundle_core.cmake: Contents/MacOS/coredist/latch, re-signed);
    # LATCH_CORE_BINARY is the core's own build (the repo's build/, as tools/build-release-native-mac.sh makes it)
    set(LATCH_CORE_BINARY ${CMAKE_CURRENT_SOURCE_DIR}/../build/latch CACHE FILEPATH "The latch CLI Latch.app carries")
    add_custom_target(latch_bundle_core ALL
        COMMAND ${CMAKE_COMMAND} -DCORE=${LATCH_CORE_BINARY} -DAPP=$<TARGET_BUNDLE_DIR:latch_gui>
                -DIDENTITY=${VPF_CODESIGN_IDENTITY} -P ${CMAKE_CURRENT_SOURCE_DIR}/app/bundle_core.cmake
        COMMENT "Latch.app: its latch CLI" VERBATIM)
    add_dependencies(latch_bundle_core latch_gui)
endif()
