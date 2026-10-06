const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const { GridFSBucket, ObjectId } = require("mongodb");
require("dotenv").config();

const app = express();

app.use(cors());
app.use(express.json());

// Frontend
app.use(express.static("public"));

let bucket;

// ======================================
// MONGODB CONNECTION
// ======================================

mongoose
  .connect(process.env.MONGO_URI)
  .then(() => {
    console.log("MongoDB connected successfully");
  })
  .catch((error) => {
    console.error(
      "MongoDB connection error:",
      error.message
    );
  });

// ======================================
// GRIDFS SETUP
// ======================================

mongoose.connection.once("open", () => {
  bucket = new GridFSBucket(
    mongoose.connection.db,
    {
      bucketName: "uploads",
    }
  );

  console.log("GridFS ready");
});

// ======================================
// ALLOWED FILE TYPES
// ======================================

const allowedMimeTypes = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
];

// ======================================
// MULTER SETUP
// ======================================

const storage = multer.memoryStorage();

const upload = multer({
  storage: storage,

  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB
  },

  fileFilter: (req, file, cb) => {
    if (allowedMimeTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(
        new Error(
          "Only PDF, JPG, JPEG, PNG and DOCX files are allowed"
        )
      );
    }
  },
});

// ======================================
// UPLOAD FILE
// ======================================

app.post("/upload", (req, res) => {
  upload.single("file")(req, res, (error) => {

    // File too large
    if (
      error instanceof multer.MulterError &&
      error.code === "LIMIT_FILE_SIZE"
    ) {
      return res.status(400).json({
        message:
          "File is too large. Maximum file size is 5MB.",
      });
    }

    // Invalid file type
    if (error) {
      return res.status(400).json({
        message: error.message,
      });
    }

    // No file selected
    if (!req.file) {
      return res.status(400).json({
        message: "Please select a file",
      });
    }

    // Database not ready
    if (!bucket) {
      return res.status(503).json({
        message: "Database is not ready",
      });
    }

    const uploadStream =
      bucket.openUploadStream(
        req.file.originalname,
        {
          metadata: {
            contentType: req.file.mimetype,
          },
        }
      );

    uploadStream.end(req.file.buffer);

    uploadStream.on("finish", () => {
      res.status(201).json({
        message: "File uploaded successfully",
        fileId: uploadStream.id,
        filename: req.file.originalname,
        size: req.file.size,
        contentType: req.file.mimetype,
      });
    });

    uploadStream.on("error", (error) => {
      res.status(500).json({
        message: "File upload failed",
        error: error.message,
      });
    });
  });
});

// ======================================
// GET ALL FILES
// ======================================

app.get("/files", async (req, res) => {
  try {

    if (!bucket) {
      return res.status(503).json({
        message: "Database is not ready",
      });
    }

    const files =
      await mongoose.connection.db
        .collection("uploads.files")
        .find({})
        .sort({
          uploadDate: -1,
        })
        .toArray();

    const fileList = files.map((file) => ({
      id: file._id,
      filename: file.filename,
      size: file.length,
      uploadDate: file.uploadDate,

      contentType:
        file.metadata?.contentType ||
        file.contentType ||
        getContentType(file.filename),
    }));

    res.status(200).json(fileList);

  } catch (error) {

    res.status(500).json({
      message: "Failed to get files",
      error: error.message,
    });

  }
});

// ======================================
// GET CONTENT TYPE
// ======================================

function getContentType(filename) {

  const extension =
    path.extname(filename).toLowerCase();

  if (
    extension === ".jpg" ||
    extension === ".jpeg"
  ) {
    return "image/jpeg";
  }

  if (extension === ".png") {
    return "image/png";
  }

  if (extension === ".pdf") {
    return "application/pdf";
  }

  if (extension === ".docx") {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }

  return "application/octet-stream";
}

// ======================================
// VIEW FILE
// ======================================

app.get("/files/:filename", async (req, res) => {

  try {

    if (!bucket) {
      return res.status(503).json({
        message: "Database is not ready",
      });
    }

    const filename =
      decodeURIComponent(
        req.params.filename
      );

    const file =
      await mongoose.connection.db
        .collection("uploads.files")
        .findOne({
          filename: filename,
        });

    if (!file) {
      return res.status(404).json({
        message: "File not found",
      });
    }

    const contentType =
      file.metadata?.contentType ||
      file.contentType ||
      getContentType(file.filename);

    res.setHeader(
      "Content-Type",
      contentType
    );

    // Browser preview
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${encodeURIComponent(
        file.filename
      )}"`
    );

    const downloadStream =
      bucket.openDownloadStream(
        file._id
      );

    downloadStream.on(
      "error",
      (error) => {

        console.error(
          "File view error:",
          error.message
        );

        if (!res.headersSent) {
          res.status(404).json({
            message: "File not found",
          });
        }
      }
    );

    downloadStream.pipe(res);

  } catch (error) {

    res.status(500).json({
      message: "Failed to view file",
      error: error.message,
    });

  }
});

// ======================================
// DELETE FILE
// ======================================

app.delete("/files/:id", async (req, res) => {

  try {

    if (!bucket) {
      return res.status(503).json({
        message: "Database is not ready",
      });
    }

    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({
        message: "Invalid file ID",
      });
    }

    const fileId =
      new ObjectId(req.params.id);

    const file =
      await mongoose.connection.db
        .collection("uploads.files")
        .findOne({
          _id: fileId,
        });

    if (!file) {
      return res.status(404).json({
        message: "File not found",
      });
    }

    await bucket.delete(fileId);

    res.status(200).json({
      message:
        "File deleted successfully",
      filename: file.filename,
    });

  } catch (error) {

    res.status(500).json({
      message: "File delete failed",
      error: error.message,
    });

  }
});

// ======================================
// HOME PAGE
// ======================================

app.get("/", (req, res) => {

  res.sendFile(
    path.join(
      __dirname,
      "public",
      "index.html"
    )
  );

});

// ======================================
// START SERVER
// ======================================

const PORT =
  process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(
    `Server running on port ${PORT}`
  );
});