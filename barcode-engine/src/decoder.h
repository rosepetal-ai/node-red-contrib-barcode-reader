#include <string>
#include <vector>
#include <opencv2/opencv.hpp>

// Decoder primitives - take grayscale images only
// formats: empty vector = all symbologies (default); otherwise allowlist of canonical names
std::string decode_zbar(const cv::Mat& grayscale,
                        const std::vector<std::string>& formats);
std::string decode_zxing(const cv::Mat& grayscale,
                         bool tryHarder,
                         const std::vector<std::string>& formats);

// Preprocessing primitives - convert BGR to preprocessed grayscale
cv::Mat preprocess_original(const cv::Mat& bgr);
cv::Mat preprocess_histogram(const cv::Mat& bgr);
cv::Mat preprocess_otsu(const cv::Mat& bgr);