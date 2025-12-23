#include <napi.h>
#include <fstream>
#include <vector>
#include <string>
#include <opencv2/opencv.hpp>
#include "decoder.h"

// Type validation helper functions
bool IsValidBuffer(const Napi::Value& val) {
  return !val.IsUndefined() && !val.IsNull() && val.IsBuffer();
}

bool IsValidNumber(const Napi::Value& val) {
  return !val.IsUndefined() && !val.IsNull() && val.IsNumber();
}

bool IsValidString(const Napi::Value& val) {
  return !val.IsUndefined() && !val.IsNull() && val.IsString();
}

bool IsValidImageObject(const Napi::Object& obj, Napi::Env env, std::string& errorMsg) {
  // Check for required properties existence first
  if (!obj.Has("data")) {
    errorMsg = "Missing required property 'data'";
    return false;
  }
  if (!obj.Has("width")) {
    errorMsg = "Missing required property 'width'";
    return false;
  }
  if (!obj.Has("height")) {
    errorMsg = "Missing required property 'height'";
    return false;
  }
  
  // Only check property types if all required properties exist
  // Safe property access with existence verification
  Napi::Value dataVal = obj.Get("data");
  Napi::Value widthVal = obj.Get("width");
  Napi::Value heightVal = obj.Get("height");
  
  // Additional safety: check for undefined/null values
  if (dataVal.IsUndefined() || dataVal.IsNull()) {
    errorMsg = "Property 'data' is null or undefined";
    return false;
  }
  if (widthVal.IsUndefined() || widthVal.IsNull()) {
    errorMsg = "Property 'width' is null or undefined";
    return false;
  }
  if (heightVal.IsUndefined() || heightVal.IsNull()) {
    errorMsg = "Property 'height' is null or undefined";
    return false;
  }
  
  // Now safe to check types
  if (!IsValidBuffer(dataVal)) {
    errorMsg = "Property 'data' must be a Buffer";
    return false;
  }
  if (!IsValidNumber(widthVal)) {
    errorMsg = "Property 'width' must be a number";
    return false;
  }
  if (!IsValidNumber(heightVal)) {
    errorMsg = "Property 'height' must be a number";
    return false;
  }
  
  // Check optional properties if they exist
  if (obj.Has("dtype")) {
    Napi::Value dtypeVal = obj.Get("dtype");
    if (!dtypeVal.IsUndefined() && !dtypeVal.IsNull() && !IsValidString(dtypeVal)) {
      errorMsg = "Property 'dtype' must be a string";
      return false;
    }
  }
  if (obj.Has("colorSpace")) {
    Napi::Value colorSpaceVal = obj.Get("colorSpace");
    if (!colorSpaceVal.IsUndefined() && !colorSpaceVal.IsNull() && !IsValidString(colorSpaceVal)) {
      errorMsg = "Property 'colorSpace' must be a string";
      return false;
    }
  }
  if (obj.Has("channels")) {
    Napi::Value channelsVal = obj.Get("channels");
    if (!channelsVal.IsUndefined() && !channelsVal.IsNull()) {
      if (!IsValidNumber(channelsVal) && !IsValidString(channelsVal)) {
        errorMsg = "Property 'channels' must be a number or string";
        return false;
      }
    }
  }
  
  return true;
}

// Helper function to convert input to cv::Mat (shared by decoder and convertToMat)
// Returns empty Mat on error, check with mat.empty()
cv::Mat InputToMat(const Napi::Value& input, std::string& errorMsg) {
  Napi::Env env = input.Env();
  errorMsg.clear();

  // Additional safety: check for null/undefined input
  if (input.IsUndefined() || input.IsNull()) {
    errorMsg = "Input is null or undefined";
    return cv::Mat();
  }

  // --- 1. Handle raw object input ---
  if (input.IsObject() && !input.IsBuffer()) {
    Napi::Object obj = input.As<Napi::Object>();
    
    // Validate the image object structure and types
    if (!IsValidImageObject(obj, env, errorMsg)) {
      errorMsg = "Invalid image object: " + errorMsg;
      return cv::Mat();
    }
    
    // Safe casting after validation
    auto dataBuf = obj.Get("data").As<Napi::Buffer<uint8_t>>();
    int width = obj.Get("width").As<Napi::Number>().Int32Value();
    int height = obj.Get("height").As<Napi::Number>().Int32Value();
    
    // Additional value validation
    if (width <= 0 || height <= 0) {
      errorMsg = "Width and height must be positive numbers (width: " + 
                 std::to_string(width) + ", height: " + std::to_string(height) + ")";
      return cv::Mat();
    }
    
    // Check for potential integer overflow
    const int MAX_IMAGE_DIMENSION = 32768; // Reasonable maximum
    if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
      errorMsg = "Image dimensions too large (max: " + std::to_string(MAX_IMAGE_DIMENSION) + ")";
      return cv::Mat();
    }

    // Validate dtype if present (only uint8 supported)
    if (obj.Has("dtype")) {
      std::string dtype = obj.Get("dtype").As<Napi::String>().Utf8Value();
      if (dtype != "uint8") {
        errorMsg = "Unsupported dtype: " + dtype + ". Only 'uint8' is currently supported.";
        return cv::Mat();
      }
    }

    std::string colorSpace;
    int channels = 0;
    int cvType = CV_8UC3; // default

    // --- Format 1: New rosepetal bitmap format with colorSpace ---
    if (obj.Has("colorSpace")) {
      colorSpace = obj.Get("colorSpace").As<Napi::String>().Utf8Value();
      
      // Determine channels and OpenCV type from colorSpace
      if (colorSpace == "GRAY") {
        channels = 1;
        cvType = CV_8UC1;
      } else if (colorSpace == "RGB" || colorSpace == "BGR") {
        channels = 3;
        cvType = CV_8UC3;
      } else if (colorSpace == "RGBA" || colorSpace == "BGRA") {
        channels = 4;
        cvType = CV_8UC4;
      } else {
        errorMsg = "Unsupported colorSpace: " + colorSpace + ". Supported values: GRAY, RGB, BGR, RGBA, BGRA";
        return cv::Mat();
      }

      // Validate data length matches dimensions
      size_t expectedBytes = width * height * channels;
      
      // Check for potential overflow in size calculation
      const size_t MAX_BUFFER_SIZE = 500 * 1024 * 1024; // 500 MB max
      if (expectedBytes > MAX_BUFFER_SIZE) {
        errorMsg = "Image data too large: " + std::to_string(expectedBytes) + " bytes (max: " + 
                   std::to_string(MAX_BUFFER_SIZE) + " bytes)";
        return cv::Mat();
      }
      
      if (dataBuf.Length() != expectedBytes) {
        errorMsg = "Data length mismatch: expected " + std::to_string(expectedBytes) + 
                   " bytes (" + std::to_string(width) + "x" + std::to_string(height) + "x" + 
                   std::to_string(channels) + "), got " + std::to_string(dataBuf.Length()) + " bytes";
        return cv::Mat();
      }
    }
    // --- Format 2: Channels field ---
    else if (obj.Has("channels")) {
      // Handle both string ("int8_RGB") and numeric (3) channels formats
      if (obj.Get("channels").IsNumber()) {
        // Numeric channels format
        channels = obj.Get("channels").As<Napi::Number>().Int32Value();
          
        switch (channels) {
          case 1:
            cvType = CV_8UC1;
            colorSpace = "GRAY";
            break;
          case 3:
            cvType = CV_8UC3;
            colorSpace = "RGB";
            break;
          case 4:
            cvType = CV_8UC4;
            colorSpace = "RGBA";
            break;
          default:
            errorMsg = "Unsupported channel count: " + std::to_string(channels);
            return cv::Mat();
        }
      }
    }
    // --- Format 3: Infer from data size ---
    else {
      // Try to infer channels from data length
      size_t pixelCount = width * height;
      if (pixelCount == 0) {
        errorMsg = "Invalid image dimensions: width and height must be > 0";
        return cv::Mat();
      }
      
      channels = dataBuf.Length() / pixelCount;
      if (dataBuf.Length() % pixelCount != 0) {
        errorMsg = "Cannot infer channels: data.length (" + std::to_string(dataBuf.Length()) + 
                   ") is not divisible by width*height (" + std::to_string(pixelCount) + ")";
        return cv::Mat();
      }
      
      switch (channels) {
        case 1:
          cvType = CV_8UC1;
          colorSpace = "GRAY";
          break;
        case 3:
          cvType = CV_8UC3;
          colorSpace = "RGB"; // default assumption
          break;
        case 4:
          cvType = CV_8UC4;
          colorSpace = "RGBA"; // default assumption
          break;
        default:
          errorMsg = "Cannot determine default colorSpace for " + std::to_string(channels) + " channels";
          return cv::Mat();
      }
    }

    // Create a defensive copy of the data to prevent segmentation faults
    // This ensures the Mat owns its data and won't access deallocated memory
    cv::Mat mat(height, width, cvType);
    if (mat.empty()) {
      errorMsg = "Failed to create Mat with dimensions " + std::to_string(width) + "x" + std::to_string(height);
      return cv::Mat();
    }
    
    // Verify the Mat's expected data size matches our buffer
    size_t matDataSize = mat.total() * mat.elemSize();
    if (matDataSize != dataBuf.Length()) {
      errorMsg = "Internal error: Mat data size (" + std::to_string(matDataSize) + 
                ") doesn't match buffer length (" + std::to_string(dataBuf.Length()) + ")";
      return cv::Mat();
    }
    
    // Safely copy the data
    std::memcpy(mat.data, dataBuf.Data(), dataBuf.Length());

    
    cv::Mat bgrMat;
    if (colorSpace == "RGB") {
      cv::cvtColor(mat, bgrMat, cv::COLOR_RGB2BGR);
      return bgrMat;
    } else if (colorSpace == "RGBA") {
      cv::cvtColor(mat, bgrMat, cv::COLOR_RGBA2BGRA);
      return bgrMat;
    }

    return mat;
  }
  // --- 2. Handle buffer input ---
  else if (input.IsBuffer()) {
    auto buf = input.As<Napi::Buffer<uint8_t>>();
    cv::Mat tmp(1, buf.Length(), CV_8UC1, buf.Data());
    cv::Mat mat = cv::imdecode(tmp, cv::IMREAD_UNCHANGED);

    if (mat.empty()) {
      errorMsg = "Failed to decode image buffer";
      return cv::Mat();
    }
    return mat;
  }
  else {
    errorMsg = "Invalid input: Expected Buffer or raw image object";
    return cv::Mat();
  }
}

// ZBar decoder - expects grayscale image
Napi::Value decoder_zbar(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1) {
    Napi::TypeError::New(env, "Expected at least 1 argument: grayscale image data (Buffer or raw image object)").ThrowAsJavaScriptException();
    return env.Null();
  }

  // Validate input type before processing
  if (!info[0].IsObject() && !info[0].IsBuffer()) {
    Napi::TypeError::New(env, "Argument must be a Buffer or image object").ThrowAsJavaScriptException();
    return env.Null();
  }

  try {
    std::string errorMsg;
    cv::Mat mat = InputToMat(info[0], errorMsg);
    if (mat.empty()) {
      Napi::Error::New(env, errorMsg.empty() ? "Failed to convert input to valid image matrix" : errorMsg).ThrowAsJavaScriptException();
      return env.Null();
    }
    std::string result = decode_zbar(mat);
    return Napi::String::New(env, result);
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Null();
  }
}

// ZXing decoder - expects grayscale image with tryHarder option
Napi::Value decoder_zxing(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 2) {
    Napi::TypeError::New(env, "Expected 2 arguments: grayscale image data, tryHarder (boolean)").ThrowAsJavaScriptException();
    return env.Null();
  }

  // Validate input types
  if (!info[0].IsObject() && !info[0].IsBuffer()) {
    Napi::TypeError::New(env, "First argument must be a Buffer or image object").ThrowAsJavaScriptException();
    return env.Null();
  }
  if (!info[1].IsBoolean()) {
    Napi::TypeError::New(env, "Second argument (tryHarder) must be a boolean").ThrowAsJavaScriptException();
    return env.Null();
  }

  try {
    std::string errorMsg;
    cv::Mat mat = InputToMat(info[0], errorMsg);
    if (mat.empty()) {
      Napi::Error::New(env, errorMsg.empty() ? "Failed to convert input to valid image matrix" : errorMsg).ThrowAsJavaScriptException();
      return env.Null();
    }

    bool tryHarder = info[1].As<Napi::Boolean>().Value();
    std::string result = decode_zxing(mat, tryHarder);
    return Napi::String::New(env, result);
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Null();
  }
}

// Forward declaration
Napi::Object MatToRawJS(Napi::Env env, const cv::Mat& m, const std::string& order);

// Preprocessing: Original (BGR to Grayscale)
Napi::Value preprocessOriginal(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1) {
    Napi::TypeError::New(env, "Expected 1 argument: image data (Buffer or raw image object)").ThrowAsJavaScriptException();
    return env.Null();
  }

  if (!info[0].IsObject() && !info[0].IsBuffer()) {
    Napi::TypeError::New(env, "Argument must be a Buffer or image object").ThrowAsJavaScriptException();
    return env.Null();
  }

  try {
    std::string errorMsg;
    cv::Mat mat = InputToMat(info[0], errorMsg);
    if (mat.empty()) {
      Napi::Error::New(env, errorMsg.empty() ? "Failed to convert input to valid image matrix" : errorMsg).ThrowAsJavaScriptException();
      return env.Null();
    }

    cv::Mat processed = preprocess_original(mat);
    if (processed.empty()) {
      Napi::Error::New(env, "Preprocessing failed").ThrowAsJavaScriptException();
      return env.Null();
    }

    return MatToRawJS(env, processed, "GRAY");
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Null();
  }
}

// Preprocessing: Histogram Equalization
Napi::Value preprocessHistogram(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1) {
    Napi::TypeError::New(env, "Expected 1 argument: image data (Buffer or raw image object)").ThrowAsJavaScriptException();
    return env.Null();
  }

  if (!info[0].IsObject() && !info[0].IsBuffer()) {
    Napi::TypeError::New(env, "Argument must be a Buffer or image object").ThrowAsJavaScriptException();
    return env.Null();
  }

  try {
    std::string errorMsg;
    cv::Mat mat = InputToMat(info[0], errorMsg);
    if (mat.empty()) {
      Napi::Error::New(env, errorMsg.empty() ? "Failed to convert input to valid image matrix" : errorMsg).ThrowAsJavaScriptException();
      return env.Null();
    }

    cv::Mat processed = preprocess_histogram(mat);
    if (processed.empty()) {
      Napi::Error::New(env, "Preprocessing failed").ThrowAsJavaScriptException();
      return env.Null();
    }

    return MatToRawJS(env, processed, "GRAY");
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Null();
  }
}

// Preprocessing: Otsu Threshold
Napi::Value preprocessOtsu(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1) {
    Napi::TypeError::New(env, "Expected 1 argument: image data (Buffer or raw image object)").ThrowAsJavaScriptException();
    return env.Null();
  }

  if (!info[0].IsObject() && !info[0].IsBuffer()) {
    Napi::TypeError::New(env, "Argument must be a Buffer or image object").ThrowAsJavaScriptException();
    return env.Null();
  }

  try {
    std::string errorMsg;
    cv::Mat mat = InputToMat(info[0], errorMsg);
    if (mat.empty()) {
      Napi::Error::New(env, errorMsg.empty() ? "Failed to convert input to valid image matrix" : errorMsg).ThrowAsJavaScriptException();
      return env.Null();
    }

    cv::Mat processed = preprocess_otsu(mat);
    if (processed.empty()) {
      Napi::Error::New(env, "Preprocessing failed").ThrowAsJavaScriptException();
      return env.Null();
    }

    return MatToRawJS(env, processed, "GRAY");
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Null();
  }
}

// Helper function to extract channel order from full channel string
std::string ExtractChannelOrder(const std::string& chFull) {
  auto pos = chFull.find('_');
  return pos == std::string::npos ? chFull : chFull.substr(pos + 1);
}

// Helper function to convert cv::Mat to raw JS object
Napi::Object MatToRawJS(Napi::Env env, const cv::Mat& m, const std::string& order) {
  Napi::Object o = Napi::Object::New(env);
  o.Set("width", Napi::Number::New(env, m.cols));
  o.Set("height", Napi::Number::New(env, m.rows));

  // Use new rosepetal bitmap format with colorSpace
  o.Set("colorSpace", Napi::String::New(env, order));
  o.Set("dtype", Napi::String::New(env, "uint8"));

  size_t bytes = m.total() * m.elemSize();
  auto* raw = new uint8_t[bytes];
  std::memcpy(raw, m.data, bytes);

  o.Set("data", Napi::Buffer<uint8_t>::New(
    env, raw, bytes,
    [](Napi::Env, uint8_t* p) { delete[] p; }));
  return o;
}

// Helper function to get color space from input object
std::string GetColorSpaceFromInput(const Napi::Object& obj, const cv::Mat& mat) {
  // Priority 1: colorSpace field (new rosepetal format)
  if (obj.Has("colorSpace")) {
    return obj.Get("colorSpace").As<Napi::String>().Utf8Value();
  }
    
  // Priority 3: Infer from channel count with sensible defaults
  switch (mat.channels()) {
    case 1:
      return "GRAY";
    case 3:
      return "RGB"; // Default assumption for rosepetal platform
    case 4:
      return "RGBA"; // Default assumption for rosepetal platform
    default:
      return "RGB"; // fallback
  }
}

Napi::Value convertToMat(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1) {
    Napi::TypeError::New(env, "Expected 1 argument: image data (Buffer or raw image object)").ThrowAsJavaScriptException();
    return env.Null();
  }

  // Validate input type before processing
  if (!info[0].IsObject() && !info[0].IsBuffer()) {
    Napi::TypeError::New(env, "Argument must be a Buffer or image object").ThrowAsJavaScriptException();
    return env.Null();
  }

  try {
    std::string channelOrder = "BGR"; // Default for buffers (OpenCV decoded images)
    std::string errorMsg;
    
    cv::Mat mat = InputToMat(info[0], errorMsg);
    if (mat.empty()) {
      Napi::Error::New(env, errorMsg.empty() ? "Failed to convert input to valid image matrix" : errorMsg).ThrowAsJavaScriptException();
      return env.Null();
    }
    
    // Detect channel order from input if it's a raw object
    if (info[0].IsObject() && !info[0].IsBuffer()) {
      Napi::Object obj = info[0].As<Napi::Object>();
      channelOrder = GetColorSpaceFromInput(obj, mat);
    } else {
      // For buffer inputs, use OpenCV's default channel ordering
      if (mat.channels() == 1) {
        channelOrder = "GRAY";
      } else if (mat.channels() == 4) {
        channelOrder = "BGRA";
      } else {
        channelOrder = "BGR"; // OpenCV default for 3-channel decoded images
      }
    }

    return MatToRawJS(env, mat, channelOrder);
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Null();
  }
}

Napi::Value resizeImage(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 2) {
    Napi::TypeError::New(env, "Expected 2 arguments: image data (Buffer or raw image object) and resize percentage").ThrowAsJavaScriptException();
    return env.Null();
  }

  // Validate input types
  if (!info[0].IsObject() && !info[0].IsBuffer()) {
    Napi::TypeError::New(env, "First argument must be a Buffer or image object").ThrowAsJavaScriptException();
    return env.Null();
  }
  if (!info[1].IsNumber()) {
    Napi::TypeError::New(env, "Second argument (resize percentage) must be a number").ThrowAsJavaScriptException();
    return env.Null();
  }

  try {
    // Convert input to cv::Mat
    std::string errorMsg;
    cv::Mat mat = InputToMat(info[0], errorMsg);
    if (mat.empty()) {
      Napi::Error::New(env, errorMsg.empty() ? "Failed to convert input to valid image matrix" : errorMsg).ThrowAsJavaScriptException();
      return env.Null();
    }
    
    // Get resize percentage
    double resizePercentage = info[1].As<Napi::Number>().DoubleValue();
    
    // Validate percentage range
    if (resizePercentage <= 0 || resizePercentage > 100) {
      Napi::Error::New(env, "Resize percentage must be between 0 and 100").ThrowAsJavaScriptException();
      return env.Null();
    }
    
    // If percentage is 100, return original image
    if (resizePercentage >= 100.0) {
      // Detect channel order from input if it's a raw object
      std::string channelOrder = "BGR"; // Default for buffers
      if (info[0].IsObject() && !info[0].IsBuffer()) {
        Napi::Object obj = info[0].As<Napi::Object>();
        channelOrder = GetColorSpaceFromInput(obj, mat);
      } else {
        // For buffer inputs, use OpenCV's default channel ordering
        if (mat.channels() == 1) {
          channelOrder = "GRAY";
        } else if (mat.channels() == 4) {
          channelOrder = "BGRA";
        } else {
          channelOrder = "BGR"; // OpenCV default for 3-channel decoded images
        }
      }
      return MatToRawJS(env, mat, channelOrder);
    }
    
    // Resize the image
    cv::Mat resizedMat;
    double scale = resizePercentage / 100.0;
    cv::resize(mat, resizedMat, cv::Size(), scale, scale, cv::INTER_LINEAR);
    
    // Detect channel order from input to maintain consistency
    std::string channelOrder = "BGR"; // Default for buffers
    if (info[0].IsObject() && !info[0].IsBuffer()) {
      Napi::Object obj = info[0].As<Napi::Object>();
      channelOrder = GetColorSpaceFromInput(obj, mat);
    } else {
      // For buffer inputs, use OpenCV's default channel ordering
      if (resizedMat.channels() == 1) {
        channelOrder = "GRAY";
      } else if (resizedMat.channels() == 4) {
        channelOrder = "BGRA";
      } else {
        channelOrder = "BGR"; // OpenCV default for 3-channel decoded images
      }
    }
    
    return MatToRawJS(env, resizedMat, channelOrder);
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Null();
  }
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  // Decoder primitives
  exports.Set(
    Napi::String::New(env, "decode_zbar"),
    Napi::Function::New(env, decoder_zbar)
  );
  exports.Set(
    Napi::String::New(env, "decode_zxing"),
    Napi::Function::New(env, decoder_zxing)
  );

  // Preprocessing primitives
  exports.Set(
    Napi::String::New(env, "preprocess_original"),
    Napi::Function::New(env, preprocessOriginal)
  );
  exports.Set(
    Napi::String::New(env, "preprocess_histogram"),
    Napi::Function::New(env, preprocessHistogram)
  );
  exports.Set(
    Napi::String::New(env, "preprocess_otsu"),
    Napi::Function::New(env, preprocessOtsu)
  );

  // Utility functions (keep these)
  exports.Set(
    Napi::String::New(env, "resizeImage"),
    Napi::Function::New(env, resizeImage)
  );
  exports.Set(
    Napi::String::New(env, "convertToMat"),
    Napi::Function::New(env, convertToMat)
  );

  return exports;
}

NODE_API_MODULE(barcode, Init)