cmake_minimum_required(VERSION 3.20)
project(latch LANGUAGES CXX VERSION 0.1.0)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_executable(latch
  src/main.cpp
  src/bootstrap.cpp
  src/extract.cpp
  src/process.cpp
  src/progress.cpp
)
target_include_directories(latch PRIVATE src)

if (MSVC)
  target_compile_options(latch PRIVATE /W3 /utf-8)
  target_compile_definitions(latch PRIVATE _CRT_SECURE_NO_WARNINGS NOMINMAX)
else()
  target_compile_options(latch PRIVATE -Wall -Wextra)
endif()

if (WIN32)
  set(LATCH_YTDLP_BIN  "${CMAKE_SOURCE_DIR}/binaries/yt-dlp.exe")
  set(LATCH_FFMPEG_BIN "${CMAKE_SOURCE_DIR}/binaries/ffmpeg.exe")
  if (EXISTS "${LATCH_YTDLP_BIN}")
    add_custom_command(TARGET latch POST_BUILD
      COMMAND ${CMAKE_COMMAND} -E copy_if_different
        "${LATCH_YTDLP_BIN}" "$<TARGET_FILE_DIR:latch>/yt-dlp.exe")
  else()
    message(WARNING "yt-dlp.exe not found at ${LATCH_YTDLP_BIN}")
  endif()
  if (EXISTS "${LATCH_FFMPEG_BIN}")
    add_custom_command(TARGET latch POST_BUILD
      COMMAND ${CMAKE_COMMAND} -E copy_if_different
        "${LATCH_FFMPEG_BIN}" "$<TARGET_FILE_DIR:latch>/ffmpeg.exe")
  else()
    message(WARNING "ffmpeg.exe not found at ${LATCH_FFMPEG_BIN}")
  endif()
endif()
