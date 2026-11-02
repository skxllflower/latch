# Latch's native GUI (vpf): the extract window, standalone, replacing the Tauri GUI in gui/. Its own build, outside
# the core's (the latch CLI at the repo root stays the worker the window drives: expand, probe, extract, update).
#
#   cmake -S native -B native/build -A x64 [-DFETCHCONTENT_SOURCE_DIR_VACANTLABS=<vacant-labs checkout>]
#                                           [-DFETCHCONTENT_SOURCE_DIR_WAVDESK=<wavdesk checkout>]
#   cmake --build native/build --config Release     -> native/build/bin/Release/latch-gui.exe
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
    GIT_TAG        11a77309c670284aab3a6b3ec422dd7e966f575d   # (WAVdesk native's own pin: the shared window was written on it)
    GIT_SUBMODULES vpf/third_party/clap vpf/third_party/vst3/pluginterfaces
)
FetchContent_Declare(wavdesk
    GIT_REPOSITORY https://github.com/skxllflower/wavdesk.git
    GIT_TAG        65cd0a8cf1a537c9e0c8a7236c59d4fecd1ee390   # feat/native-shell (children born in their kill-on-close job)
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

# WAVdesk's shell files the window is made of (each one unchanged; native/shell in the pinned commit)
set(WD ${wavdesk_SOURCE_DIR}/native/shell)
set(LATCH_SHARED_SOURCES
    ${WD}/latch_window.cpp ${WD}/ext_window.cpp ${WD}/external_tools.cpp
    ${WD}/look.cpp ${WD}/skin.cpp ${WD}/skin_focused.cpp ${WD}/skin_vx.cpp ${WD}/skin_zen.cpp
    ${WD}/dialog_window.cpp ${WD}/popup_motion.cpp ${WD}/window_place.cpp ${WD}/window_fit.cpp
    ${WD}/ui_state.cpp ${WD}/settings_store.cpp ${WD}/core_process.cpp ${WD}/dev_run.cpp
    ${WD}/menus.cpp ${WD}/context_menu.cpp)
set(LATCH_APP_SOURCES app/main.cpp app/latch_app.cpp app/about_window.cpp app/host_stubs.cpp app/self_register.cpp app/app_log.cpp)

if(APPLE)
    set(LATCH_EXE_NAME Latch)        # (Latch.app, as the Tauri bundle was named)
else()
    set(LATCH_EXE_NAME latch-gui)    # (the Tauri exe name: the installer, the uninstall key and WAVdesk look for it)
endif()
vpf_add_standalone_app(latch_gui NAME ${LATCH_EXE_NAME} BUNDLE_ID com.vacantsystems.latch VERSION ${LATCH_VERSION}
    SOURCES ${LATCH_APP_SOURCES} ${LATCH_SHARED_SOURCES}
    PLIST ${CMAKE_CURRENT_SOURCE_DIR}/app/Info.plist.in
    WIN_RC ${CMAKE_CURRENT_BINARY_DIR}/latch_gui.rc)
target_include_directories(latch_gui PRIVATE ${WD} ${CMAKE_CURRENT_SOURCE_DIR}/compat)
target_link_libraries(latch_gui PRIVATE vpf::app nlohmann_json::nlohmann_json)
target_compile_definitions(latch_gui PRIVATE LATCH_VERSION="${LATCH_VERSION}")
# the VX skin's packs, embedded as WAVdesk embeds them (skin_vx.cpp reads kWavdeskVx)
file(GLOB LATCH_VX_FILES CONFIGURE_DEPENDS ${wavdesk_SOURCE_DIR}/native/assets/vx/*.json ${wavdesk_SOURCE_DIR}/native/assets/vx/*.pack)
vpf_embed_assets(latch_gui SYMBOL kWavdeskVx FILES ${LATCH_VX_FILES})
if(WIN32)
    set(LATCH_ICON ${CMAKE_CURRENT_SOURCE_DIR}/../gui/src-tauri/icons/icon.ico)
    configure_file(app/latch_gui.rc.in ${CMAKE_CURRENT_BINARY_DIR}/latch_gui.rc @ONLY)
    # the UTF-8 active code page: the CRT opens UTF-8 paths as such (the core binary's pair)
    target_sources(latch_gui PRIVATE app/latch_gui.manifest)
    target_compile_definitions(latch_gui PRIVATE UNICODE _UNICODE)
    target_link_libraries(latch_gui PRIVATE shell32 ole32)
elseif(APPLE)
    target_link_libraries(latch_gui PRIVATE "-framework Foundation" "-framework AppKit")
endif()
