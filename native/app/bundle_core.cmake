# Latch.app's own latch CLI (run by native/CMakeLists.txt's latch_bundle_core target after each build, macOS): the core
# copied to Contents/MacOS/coredist/latch, where the Tauri bundle had it (ownCore() and the shared lookup look there; a
# bundle is never a dev run, so it finds no other), then the bundle re-signed inside out: the core, then the app.
#   -DCORE=<latch CLI> -DAPP=<Latch.app> [-DIDENTITY=<codesign identity, - = ad hoc, empty = none>]
if(NOT EXISTS "${CORE}")
    message(WARNING "no latch CLI at ${CORE}: Latch.app runs without its own core (build it: cmake --build build --target latch)")
    return()
endif()
set(dest "${APP}/Contents/MacOS/coredist/latch")
file(MAKE_DIRECTORY "${APP}/Contents/MacOS/coredist")
execute_process(COMMAND ${CMAKE_COMMAND} -E copy_if_different "${CORE}" "${dest}" RESULT_VARIABLE rc)
if(NOT rc EQUAL 0)
    message(FATAL_ERROR "copying ${CORE} into ${APP} failed")
endif()
if(IDENTITY)
    # (never --deep: each piece signed on its own, the bundle sealed last)
    execute_process(COMMAND codesign --force --sign "${IDENTITY}" "${dest}" RESULT_VARIABLE rc1)
    execute_process(COMMAND codesign --force --sign "${IDENTITY}" "${APP}" RESULT_VARIABLE rc2)
    if(NOT rc1 EQUAL 0 OR NOT rc2 EQUAL 0)
        message(FATAL_ERROR "signing ${APP} failed")
    endif()
endif()
