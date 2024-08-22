import { ReactiveCache } from '/imports/reactiveCache';
import { Meteor } from 'meteor/meteor';
import { FilesCollection } from 'meteor/ostrio:files';
import { isFileValid } from './fileValidation';
import { createBucket } from './lib/grid/createBucket';
import fs from 'fs';
import path from 'path';
import { AttachmentStoreStrategyFilesystem, AttachmentStoreStrategyGridFs, AttachmentStoreStrategyS3 } from '/models/lib/attachmentStoreStrategy';
import FileStoreStrategyFactory, { moveToStorage, rename, STORAGE_NAME_FILESYSTEM, STORAGE_NAME_GRIDFS, STORAGE_NAME_S3 } from '/models/lib/fileStoreStrategy';

let attachmentUploadExternalProgram;
let attachmentUploadMimeTypes = [];
let attachmentUploadSize = 0;
let attachmentBucket;
let storagePath;

if (Meteor.isServer) {
  attachmentBucket = createBucket('attachments');

  if (process.env.ATTACHMENTS_UPLOAD_MIME_TYPES) {
    attachmentUploadMimeTypes = process.env.ATTACHMENTS_UPLOAD_MIME_TYPES.split(',').map(value => value.trim());
  }

  if (process.env.ATTACHMENTS_UPLOAD_MAX_SIZE) {
    attachmentUploadSize = parseInt(process.env.ATTACHMENTS_UPLOAD_MAX_SIZE);
    if (isNaN(attachmentUploadSize)) {
      attachmentUploadSize = 0;
    }
  }

  if (process.env.ATTACHMENTS_UPLOAD_EXTERNAL_PROGRAM) {
    attachmentUploadExternalProgram = process.env.ATTACHMENTS_UPLOAD_EXTERNAL_PROGRAM;
    if (!attachmentUploadExternalProgram.includes("{file}")) {
      attachmentUploadExternalProgram = undefined;
    }
  }

  if (process.env.WRITABLE_PATH) {
    storagePath = path.join(process.env.WRITABLE_PATH, 'attachments');
  } else {
    throw new Error('Environment variable WRITABLE_PATH is not defined.');
  }
}

export const fileStoreStrategyFactory = new FileStoreStrategyFactory(
  AttachmentStoreStrategyFilesystem,
  storagePath,
  AttachmentStoreStrategyGridFs,
  attachmentBucket
);

Attachments = new FilesCollection({
  debug: false, // Change to `true` for debugging
  collectionName: 'attachments',
  allowClientCode: true,
  namingFunction(opts) {
    let filenameWithoutExtension = "";
    let fileId = "";

    if (opts?.name) {
      // Client
      filenameWithoutExtension = opts.name.replace(/(.+)\..+/, "$1");
      fileId = opts.meta.fileId;
      delete opts.meta.fileId;
    } else if (opts?.file?.name) {
      // Server
      if (opts.file.extension) {
        filenameWithoutExtension = opts.file.name.replace(new RegExp(opts.file.extensionWithDot + "$"), "");
      } else {
        filenameWithoutExtension = opts.file.name;
      }
      fileId = opts.fileId;
    } else {
      // Should never reach here
      filenameWithoutExtension = Math.random().toString(36).slice(2);
      fileId = Math.random().toString(36).slice(2);
    }

    // Save file only with filename of ObjectID, not including filename.
    const ret = fileId;
    return ret;
  },
  sanitize(str, max, replacement) {
    // Keep the original filename
    return str;
  },
  storagePath() {
    return fileStoreStrategyFactory.storagePath;
  },
  onAfterUpload(fileObj) {
    // Current storage is the filesystem, update object and database
    Object.keys(fileObj.versions).forEach(versionName => {
      fileObj.versions[versionName].storage = STORAGE_NAME_FILESYSTEM;
    });

    this._now = new Date();
    Attachments.update({ _id: fileObj._id }, { $set: { "versions": fileObj.versions } });
    Attachments.update({ _id: fileObj.uploadedAtOstrio }, { $set: { "uploadedAtOstrio": this._now } });

    let storageDestination = fileObj.meta.copyStorage || STORAGE_NAME_GRIDFS;
    Meteor.defer(() => Meteor.call('validateAttachmentAndMoveToStorage', fileObj._id, storageDestination));
  },
  interceptDownload(http, fileObj, versionName) {
    return fileStoreStrategyFactory.getFileStrategy(fileObj, versionName).interceptDownload(http, this.cacheControl);
  },
  onAfterRemove(files) {
    files.forEach(fileObj => {
      Object.keys(fileObj.versions).forEach(versionName => {
        fileStoreStrategyFactory.getFileStrategy(fileObj, versionName).onAfterRemove();
      });
    });
  },
  protected(fileObj) {
    if (!fileObj) {
      return false;
    }

    const board = ReactiveCache.getBoard(fileObj.meta.boardId);
    if (board.isPublic()) {
      return true;
    }

    return board.hasMember(this.userId);
  },
});

if (Meteor.isServer) {
  Attachments.allow({
    insert(userId, fileObj) {
      return allowIsBoardMember(userId, ReactiveCache.getBoard(fileObj.boardId));
    },
    update(userId, fileObj) {
      return allowIsBoardMember(userId, ReactiveCache.getBoard(fileObj.boardId));
    },
    remove(userId, fileObj) {
      return allowIsBoardMember(userId, ReactiveCache.getBoard(fileObj.boardId));
    },
    fetch: ['meta'],
  });

  Meteor.methods({
    moveAttachmentToStorage(fileObjId, storageDestination) {
      check(fileObjId, String);
      check(storageDestination, String);

      const fileObj = ReactiveCache.getAttachment(fileObjId);
      moveToStorage(fileObj, storageDestination, fileStoreStrategyFactory);
    },
    renameAttachment(fileObjId, newName) {
      check(fileObjId, String);
      check(newName, String);

      const fileObj = ReactiveCache.getAttachment(fileObjId);
      rename(fileObj, newName, fileStoreStrategyFactory);
    },
    validateAttachment(fileObjId) {
      check(fileObjId, String);

      const fileObj = ReactiveCache.getAttachment(fileObjId);
      const isValid = Promise.await(isFileValid(fileObj, attachmentUploadMimeTypes, attachmentUploadSize, attachmentUploadExternalProgram));

      if (!isValid) {
        Attachments.remove(fileObjId);
      }
    },
    validateAttachmentAndMoveToStorage(fileObjId, storageDestination) {
      check(fileObjId, String);
      check(storageDestination, String);

      Meteor.call('validateAttachment', fileObjId);

      const fileObj = ReactiveCache.getAttachment(fileObjId);

      if (fileObj) {
        Meteor.defer(() => Meteor.call('moveAttachmentToStorage', fileObjId, storageDestination));
      }
    },
  });

  Meteor.startup(() => {
    Attachments.collection.createIndex({ 'meta.cardId': 1 });
    const storagePath = fileStoreStrategyFactory.storagePath;
    if (!fs.existsSync(storagePath)) {
      console.log("Creating storagePath because it doesn't exist: " + storagePath);
      fs.mkdirSync(storagePath, { recursive: true });
    }
  });
}

export default Attachments;
