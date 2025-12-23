{
  "variables": {
    "opencv_include_dir%": "",
    "opencv_lib_dir%": "",
    "zbar_include_dir%": "",
    "zbar_lib_dir%": "",
    "zxing_include_dir%": "",
    "zxing_lib_dir%": ""
  },
  "targets": [
    {
      "target_name": "barcode",
      "cflags!": [ "-fno-exceptions", "-fno-rtti" ],
      "cflags_cc!": [ "-fno-exceptions", "-fno-rtti" ],
      "cflags": [ "-fexceptions" ],
      "cflags_cc": [ "-std=c++17", "-fexceptions" ],
      "sources": [
        "./src/decoder.cpp",
        "./src/index.cpp"
      ],
      "defines": [ "NAPI_CPP_EXCEPTIONS" ],
      "conditions": [
        ["opencv_lib_dir!='' and zbar_lib_dir!='' and zxing_lib_dir!=''", {
          "include_dirs": [
            "<(opencv_include_dir)",
            "<(zbar_include_dir)",
            "<(zxing_include_dir)",
            "<!@(node -p \"require('node-addon-api').include\")"
          ],
          "libraries": [
            "<(zbar_lib_dir)/libzbar.a",
            "<(zxing_lib_dir)/libZXing.a",
            "<(opencv_lib_dir)/libopencv_imgcodecs.a",
            "<(opencv_lib_dir)/libopencv_imgproc.a",
            "<(opencv_lib_dir)/libopencv_core.a",
            "<(opencv_lib_dir)/opencv4/3rdparty/liblibjpeg-turbo.a",
            "<(opencv_lib_dir)/opencv4/3rdparty/liblibpng.a",
            "<(opencv_lib_dir)/opencv4/3rdparty/liblibwebp.a",
            "<(opencv_lib_dir)/opencv4/3rdparty/libzlib.a",
            "-lpthread",
            "-ldl",
            "-lm"
          ],
          "ldflags": [
            "-static-libgcc",
            "-static-libstdc++"
          ]
        }, {
          "libraries": [
            "-L/usr/local/lib",
            "-L/opt/homebrew/lib",
            "-lzbar",
            "-lZXing",
            "-lopencv_core",
            "-lopencv_imgcodecs",
            "-lopencv_imgproc"
          ],
          "include_dirs": [
            "<!@(node -p \"require('node-addon-api').include\")",
            "/usr/include/opencv4",
            "/usr/local/include/opencv4",
            "/opt/homebrew/include/opencv4",
            "/usr/local/include",
            "/opt/homebrew/include",
            "/usr/include/ZXing",
            "/usr/local/include/ZXing",
            "/opt/homebrew/include/ZXing"
          ]
        }]
      ],
      "xcode_settings": {
        "GCC_ENABLE_CPP_EXCEPTIONS": "YES"
      },
      "msvs_settings": {
        "VCCLCompilerTool": {
          "ExceptionHandling": 1
        }
      }
    }
  ]
}
