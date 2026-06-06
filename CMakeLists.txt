cmake_minimum_required(VERSION 3.20)
project(latch LANGUAGES CXX VERSION 0.4.0)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_executable(latch
  src/main.cpp
  src/bootstrap.cpp
  src/clip.cpp
  src/download.cpp
  src/extract.cpp
  src/paths.cpp
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

# yt-dlp.exe / ffmpeg.exe are no longer copied next to the build output —
# they live in their managed Vacant Systems homes (see src/paths.cpp) and a
# next-to-exe copy would permanently win the portable-override tier of the
# resolution order.
