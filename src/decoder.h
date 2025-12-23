#include <string>
#include <opencv2/opencv.hpp>

// Decoder primitives - take grayscale images only
std::string decode_zbar(const cv::Mat& grayscale);
std::string decode_zxing(const cv::Mat& grayscale, bool tryHarder);

// Preprocessing primitives - convert BGR to preprocessed grayscale
cv::Mat preprocess_original(const cv::Mat& bgr);
cv::Mat preprocess_histogram(const cv::Mat& bgr);
cv::Mat preprocess_otsu(const cv::Mat& bgr);