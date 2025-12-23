/*
https://www.learnopencv.com/barcode-and-qr-code-scanner-using-zbar-and-opencv/
*/

#include <iostream>
#include <string>
#include <vector>
#include <map>
#include <set>
#include <zbar.h>
#include <ZXing/ReadBarcode.h>

#include <opencv2/core.hpp>
#include <opencv2/imgproc/imgproc.hpp>


using namespace std;
using namespace cv;
using namespace zbar;

typedef struct
{
  string type;
  string data;
  string x1;
  string y1;
  string x2;
  string y2;
  string x3;
  string y3;
  string x4;
  string y4;
  vector<Point> location;
  vector<string> detectedBy;
} decodedObject;

// Simple ZBar decoder - takes grayscale image only
string decode_zbar(const cv::Mat& grayscale)
{
  // Ensure we have a valid grayscale image
  if (grayscale.empty()) {
    return "{\"results\": []}";
  }

  // Verify it's grayscale (1 channel)
  if (grayscale.channels() != 1) {
    return "{\"error\": \"Expected grayscale image (1 channel)\"}";
  }

  // Variable for decoded objects
  vector<decodedObject> decodedObjects;

  // Create zbar scanner
  ImageScanner scanner;

  // Configure scanner
  scanner.set_config(ZBAR_QRCODE, ZBAR_CFG_ENABLE, 1);

  // Wrap image data in a zbar image
  Image image(grayscale.cols, grayscale.rows, "Y800", (uchar *)grayscale.data, grayscale.cols * grayscale.rows);

  // Scan the image for barcodes and QRCodes
  scanner.scan(image);

  decodedObject obj;

  for (Image::SymbolIterator symbol = image.symbol_begin(); symbol != image.symbol_end(); ++symbol)
  {
    obj.type = symbol->get_type_name();
    obj.data = symbol->get_data();
    obj.x3 = std::to_string(symbol->get_location_x(0));
    obj.x4 = std::to_string(symbol->get_location_x(1));
    obj.x1 = std::to_string(symbol->get_location_x(2));
    obj.x2 = std::to_string(symbol->get_location_x(3));
    obj.y3 = std::to_string(symbol->get_location_y(0));
    obj.y4 = std::to_string(symbol->get_location_y(1));
    obj.y1 = std::to_string(symbol->get_location_y(2));
    obj.y2 = std::to_string(symbol->get_location_y(3));
    decodedObjects.push_back(obj);
  }

  // Return an empty result if nothing was found
  string result = "{\"results\": [";
  if (decodedObjects.empty())
  {
    return result += "]}";
  }

  // Construct result string with decoded information
  for (vector<decodedObject>::iterator elem = decodedObjects.begin(); elem != decodedObjects.end(); ++elem)
  {
    result += "{\"type\": \"" + (*elem).type +
	    "\", \"data\": \"" + (*elem).data +
	    "\", \"points\": {\"x1\": " +  (*elem).x1 +
		", \"y1\": " + (*elem).y1 +
		", \"x2\": " + (*elem).x2 +
		", \"y2\": " + (*elem).y2 +
		", \"x3\": " + (*elem).x3 +
		", \"y3\": " + (*elem).y3 +
		", \"x4\": " + (*elem).x4 +
		", \"y4\": " + (*elem).y4 +
	    "}},";
  }
  result.pop_back();
  result += "]}";

  return result;
}

// Simple ZXing decoder - takes grayscale image only
string decode_zxing(const cv::Mat& grayscale, bool tryHarder)
{
  // Ensure we have a valid grayscale image
  if (grayscale.empty()) {
    return "{\"results\": []}";
  }

  // Verify it's grayscale (1 channel)
  if (grayscale.channels() != 1) {
    return "{\"error\": \"Expected grayscale image (1 channel)\"}";
  }

  // Configure ZXing options
  ZXing::DecodeHints hints;
  hints.setTryHarder(tryHarder);
  hints.setTryRotate(tryHarder);

  // Create ImageView from cv::Mat
  ZXing::ImageView imageView(grayscale.data, grayscale.cols, grayscale.rows, ZXing::ImageFormat::Lum);

  // Decode using ZXing
  ZXing::Results results = ZXing::ReadBarcodes(imageView, hints);

  // Build JSON result
  string result = "{\"results\": [";

  if (results.empty()) {
    return result += "]}";
  }

  bool first = true;
  for (const auto& zxResult : results) {
    if (!first) {
      result += ",";
    }
    first = false;

    // Get barcode type and data
    string type = ZXing::ToString(zxResult.format());
    string data = zxResult.text();

    // Get position information
    auto position = zxResult.position();

    // ZXing returns 4 corner points (topLeft, topRight, bottomRight, bottomLeft)
    int x1 = 0, y1 = 0, x2 = 0, y2 = 0;
    int x3 = 0, y3 = 0, x4 = 0, y4 = 0;

    if (position.size() >= 4) {
      // Map to our coordinate system (same as ZBar):
      // x3,y3 (bottom-left) → x4,y4 (bottom-right) → x1,y1 (top-right) → x2,y2 (top-left)
      x3 = position[3].x;  // bottom-left
      y3 = position[3].y;
      x4 = position[2].x;  // bottom-right
      y4 = position[2].y;
      x1 = position[1].x;  // top-right
      y1 = position[1].y;
      x2 = position[0].x;  // top-left
      y2 = position[0].y;
    }

    result += "{\"type\": \"" + type +
        "\", \"data\": \"" + data +
        "\", \"points\": {\"x1\": " + to_string(x1) +
        ", \"y1\": " + to_string(y1) +
        ", \"x2\": " + to_string(x2) +
        ", \"y2\": " + to_string(y2) +
        ", \"x3\": " + to_string(x3) +
        ", \"y3\": " + to_string(y3) +
        ", \"x4\": " + to_string(x4) +
        ", \"y4\": " + to_string(y4) +
        "}}";
  }

  result += "]}";
  return result;
}

// Preprocessing primitive: BGR to Grayscale
Mat preprocess_original(const Mat& bgr) {
  if (bgr.empty()) {
    return Mat();
  }

  Mat gray;

  // Convert based on input channels
  if (bgr.channels() == 1) {
    // Already grayscale
    gray = bgr.clone();
  } else if (bgr.channels() == 3) {
    cvtColor(bgr, gray, COLOR_BGR2GRAY);
  } else if (bgr.channels() == 4) {
    cvtColor(bgr, gray, COLOR_BGRA2GRAY);
  } else {
    // Unsupported channel count
    return Mat();
  }

  return gray;
}

// Preprocessing primitive: BGR to Histogram Equalization
Mat preprocess_histogram(const Mat& bgr) {
  if (bgr.empty()) {
    return Mat();
  }

  Mat gray, result;

  // Convert to grayscale first
  if (bgr.channels() == 1) {
    gray = bgr.clone();
  } else if (bgr.channels() == 3) {
    cvtColor(bgr, gray, COLOR_BGR2GRAY);
  } else if (bgr.channels() == 4) {
    cvtColor(bgr, gray, COLOR_BGRA2GRAY);
  } else {
    return Mat();
  }

  // Apply histogram equalization
  equalizeHist(gray, result);
  return result;
}

// Preprocessing primitive: BGR to Otsu Threshold
Mat preprocess_otsu(const Mat& bgr) {
  if (bgr.empty()) {
    return Mat();
  }

  Mat gray, histEq, result;

  // Convert to grayscale first
  if (bgr.channels() == 1) {
    gray = bgr.clone();
  } else if (bgr.channels() == 3) {
    cvtColor(bgr, gray, COLOR_BGR2GRAY);
  } else if (bgr.channels() == 4) {
    cvtColor(bgr, gray, COLOR_BGRA2GRAY);
  } else {
    return Mat();
  }

  // First apply histogram equalization
  equalizeHist(gray, histEq);

  // Then apply Otsu's thresholding
  threshold(histEq, result, 0, 255, THRESH_BINARY | THRESH_OTSU);

  return result;
}
