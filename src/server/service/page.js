const mongoose = require('mongoose');
const escapeStringRegexp = require('escape-string-regexp');
const logger = require('@alias/logger')('growi:models:page');
const debug = require('debug')('growi:models:page');
const { Writable } = require('stream');
const { createBatchStream } = require('@server/util/batch-stream');
const { isTrashPage } = require('@commons/util/path-utils');
const { serializePageSecurely } = require('../models/serializers/page-serializer');

const BULK_REINDEX_SIZE = 100;

class PageService {

  constructor(crowi) {
    this.crowi = crowi;
    this.pageEvent = crowi.event('page');

    // init
    this.pageEvent.on('create', this.pageEvent.onCreate);
    this.pageEvent.on('update', this.pageEvent.onUpdate);
    this.pageEvent.on('createMany', this.pageEvent.onCreateMany);
  }

  /**
   * go back by using redirectTo and return the paths
   *  ex: when
   *    '/page1' redirects to '/page2' and
   *    '/page2' redirects to '/page3'
   *    and given '/page3',
   *    '/page1' and '/page2' will be return
   *
   * @param {string} redirectTo
   * @param {object} redirectToPagePathMapping
   * @param {array} pagePaths
   */
  prepareShoudDeletePagesByRedirectTo(redirectTo, redirectToPagePathMapping, pagePaths = []) {
    const pagePath = redirectToPagePathMapping[redirectTo];

    if (pagePath == null) {
      return pagePaths;
    }

    pagePaths.push(pagePath);
    return this.prepareShoudDeletePagesByRedirectTo(pagePath, redirectToPagePathMapping, pagePaths);
  }

  async deleteCompletelyOperation(pageIds, pagePaths) {
    // Delete Bookmarks, Attachments, Revisions, Pages and emit delete
    const Bookmark = this.crowi.model('Bookmark');
    const Comment = this.crowi.model('Comment');
    const Page = this.crowi.model('Page');
    const PageTagRelation = this.crowi.model('PageTagRelation');
    const ShareLink = this.crowi.model('ShareLink');
    const Revision = this.crowi.model('Revision');
    const Attachment = this.crowi.model('Attachment');

    const { attachmentService } = this.crowi;
    const attachments = await Attachment.find({ page: { $in: pageIds } });

    const pages = await Page.find({ redirectTo: { $ne: null } });
    const redirectToPagePathMapping = {};
    pages.forEach((page) => {
      redirectToPagePathMapping[page.redirectTo] = page.path;
    });

    const redirectedFromPagePaths = [];
    pagePaths.forEach((pagePath) => {
      redirectedFromPagePaths.push(...this.prepareShoudDeletePagesByRedirectTo(pagePath, redirectToPagePathMapping));
    });

    return Promise.all([
      Bookmark.find({ page: { $in: pageIds } }).remove({}),
      Comment.find({ page: { $in: pageIds } }).remove({}),
      PageTagRelation.find({ relatedPage: { $in: pageIds } }).remove({}),
      ShareLink.find({ relatedPage: { $in: pageIds } }).remove({}),
      Revision.find({ path: { $in: pagePaths } }).remove({}),
      Page.find({ _id: { $in: pageIds } }).remove({}),
      Page.find({ path: { $in: redirectedFromPagePaths } }).remove({}),
      Page.find({ path: { $in: pagePaths } }).remove({}),
      attachmentService.removeAllAttachments(attachments),
    ]);
  }

  async duplicate(page, newPagePath, user, isRecursively) {
    const Page = this.crowi.model('Page');
    const PageTagRelation = mongoose.model('PageTagRelation');
    // populate
    await page.populate({ path: 'revision', model: 'Revision', select: 'body' }).execPopulate();

    // create option
    const options = { page };
    options.grant = page.grant;
    options.grantUserGroupId = page.grantedGroup;
    options.grantedUsers = page.grantedUsers;

    const createdPage = await Page.create(
      newPagePath, page.revision.body, user, options,
    );

    if (isRecursively) {
      this.duplicateDescendantsWithStream(page, newPagePath, user);
    }

    // take over tags
    const originTags = await page.findRelatedTagsById();
    let savedTags = [];
    if (originTags != null) {
      await PageTagRelation.updatePageTags(createdPage.id, originTags);
      savedTags = await PageTagRelation.listTagNamesByPage(createdPage.id);
    }

    const result = serializePageSecurely(createdPage);
    result.tags = savedTags;

    return result;
  }

  /**
   * Receive the object with oldPageId and newPageId and duplicate the tags from oldPage to newPage
   * @param {Object} pageIdMapping e.g. key: oldPageId, value: newPageId
   */
  async duplicateTags(pageIdMapping) {
    const PageTagRelation = mongoose.model('PageTagRelation');

    // convert pageId from string to ObjectId
    const pageIds = Object.keys(pageIdMapping);
    const stage = { $or: pageIds.map((pageId) => { return { relatedPage: mongoose.Types.ObjectId(pageId) } }) };

    const pagesAssociatedWithTag = await PageTagRelation.aggregate([
      {
        $match: stage,
      },
      {
        $group: {
          _id: '$relatedTag',
          relatedPages: { $push: '$relatedPage' },
        },
      },
    ]);

    const newPageTagRelation = [];
    pagesAssociatedWithTag.forEach(({ _id, relatedPages }) => {
      // relatedPages
      relatedPages.forEach((pageId) => {
        newPageTagRelation.push({
          relatedPage: pageIdMapping[pageId], // newPageId
          relatedTag: _id,
        });
      });
    });

    return PageTagRelation.insertMany(newPageTagRelation, { ordered: false });
  }

  async duplicateDescendants(pages, user, oldPagePathPrefix, newPagePathPrefix) {
    const Page = this.crowi.model('Page');
    const Revision = this.crowi.model('Revision');

    const paths = pages.map(page => (page.path));
    const revisions = await Revision.find({ path: { $in: paths } });

    // Mapping to set to the body of the new revision
    const pathRevisionMapping = {};
    revisions.forEach((revision) => {
      pathRevisionMapping[revision.path] = revision;
    });

    // key: oldPageId, value: newPageId
    const pageIdMapping = {};
    const newPages = [];
    const newRevisions = [];

    pages.forEach((page) => {
      const newPageId = new mongoose.Types.ObjectId();
      const newPagePath = page.path.replace(oldPagePathPrefix, newPagePathPrefix);
      const revisionId = new mongoose.Types.ObjectId();
      pageIdMapping[page._id] = newPageId;

      newPages.push({
        _id: newPageId,
        path: newPagePath,
        creator: user._id,
        grant: page.grant,
        grantedGroup: page.grantedGroup,
        grantedUsers: page.grantedUsers,
        lastUpdateUser: user._id,
        redirectTo: null,
        revision: revisionId,
      });

      newRevisions.push({
        _id: revisionId, path: newPagePath, body: pathRevisionMapping[page.path].body, author: user._id, format: 'markdown',
      });

    });

    await Page.insertMany(newPages, { ordered: false });
    await Revision.insertMany(newRevisions, { ordered: false });
    await this.duplicateTags(pageIdMapping);
  }

  async duplicateDescendantsWithStream(page, newPagePath, user) {
    const Page = this.crowi.model('Page');
    const newPagePathPrefix = newPagePath;
    const pathRegExp = new RegExp(`^${escapeStringRegexp(page.path)}`, 'i');

    const { PageQueryBuilder } = Page;

    const readStream = new PageQueryBuilder(Page.find())
      .addConditionToExcludeRedirect()
      .addConditionToListOnlyDescendants(page.path)
      .addConditionToFilteringByViewer(user)
      .query
      .lean()
      .cursor();

    const duplicateDescendants = this.duplicateDescendants.bind(this);
    let count = 0;
    const writeStream = new Writable({
      objectMode: true,
      async write(batch, encoding, callback) {
        try {
          count += batch.length;
          await duplicateDescendants(batch, user, pathRegExp, newPagePathPrefix);
          logger.debug(`Adding pages progressing: (count=${count})`);
        }
        catch (err) {
          logger.error('addAllPages error on add anyway: ', err);
        }

        callback();
      },
      final(callback) {
        logger.debug(`Adding pages has completed: (totalCount=${count})`);

        callback();
      },
    });

    readStream
      .pipe(createBatchStream(BULK_REINDEX_SIZE))
      .pipe(writeStream);

  }


  async deletePage(page, user, options = {}, isRecursively = false) {
    const Page = this.crowi.model('Page');
    const Revision = this.crowi.model('Revision');

    const newPath = Page.getDeletedPageName(page.path);
    const isTrashed = isTrashPage(page.path);

    if (isTrashed) {
      throw new Error('This method does NOT support deleting trashed pages.');
    }

    const socketClientId = options.socketClientId || null;
    if (!Page.isDeletableName(page.path)) {
      throw new Error('Page is not deletable.');
    }

    if (isRecursively) {
      this.deleteDescendantsWithStream(page, user, options);
    }

    // update Rivisions
    await Revision.updateRevisionListByPath(page.path, { path: newPath }, {});
    const deletedPage = await Page.findByIdAndUpdate(page._id, { $set: { path: newPath, status: Page.STATUS_DELETED } }, { new: true });
    const body = `redirect ${newPath}`;
    await Page.create(page.path, body, user, { redirectTo: newPath });

    this.pageEvent.emit('delete', page, user, socketClientId);
    this.pageEvent.emit('create', deletedPage, user, socketClientId);

    return deletedPage;
  }

  async deleteDescendants(pages, user) {
    const Page = this.crowi.model('Page');

    const pageCollection = mongoose.connection.collection('pages');
    const revisionCollection = mongoose.connection.collection('revisions');

    const deletePageBulkOp = pageCollection.initializeUnorderedBulkOp();
    const updateRevisionListOp = revisionCollection.initializeUnorderedBulkOp();
    const newPagesForRedirect = [];

    pages.forEach((page) => {
      const newPath = Page.getDeletedPageName(page.path);
      const body = `redirect ${newPath}`;

      deletePageBulkOp.find({ _id: page._id }).update({ $set: { path: newPath, status: Page.STATUS_DELETED, lastUpdateUser: user._id } });
      updateRevisionListOp.find({ path: page.path }).update({ $set: { path: newPath } });

      newPagesForRedirect.push({
        path: page.path,
        body,
        creator: user._id,
        grant: page.grant,
        grantedGroup: page.grantedGroup,
        grantedUsers: page.grantedUsers,
        lastUpdateUser: user._id,
        redirectTo: newPath,
        revision: null,
      });
    });

    try {
      await deletePageBulkOp.execute();
      await updateRevisionListOp.execute();
      await Page.insertMany(newPagesForRedirect, { ordered: false });
    }
    catch (err) {
      if (err.code !== 11000) {
        throw new Error('Failed to revert pages: ', err);
      }
    }
  }

  /**
   * Create delete stream
   */
  async deleteDescendantsWithStream(targetPage, user, options = {}) {
    const Page = this.crowi.model('Page');
    const { PageQueryBuilder } = Page;

    const readStream = new PageQueryBuilder(Page.find())
      .addConditionToExcludeRedirect()
      .addConditionToListOnlyDescendants(targetPage.path)
      .addConditionToFilteringByViewer(user)
      .query
      .lean()
      .cursor();

    const deleteDescendants = this.deleteDescendants.bind(this);
    let count = 0;
    const writeStream = new Writable({
      objectMode: true,
      async write(batch, encoding, callback) {
        try {
          count += batch.length;
          deleteDescendants(batch, user);
          logger.debug(`Reverting pages progressing: (count=${count})`);
        }
        catch (err) {
          logger.error('revertPages error on add anyway: ', err);
        }

        callback();
      },
      final(callback) {
        logger.debug(`Reverting pages has completed: (totalCount=${count})`);

        callback();
      },
    });

    readStream
      .pipe(createBatchStream(BULK_REINDEX_SIZE))
      .pipe(writeStream);
  }

  // delete multiple pages
  async deleteMultipleCompletely(pages, user, options = {}) {
    const ids = pages.map(page => (page._id));
    const paths = pages.map(page => (page.path));
    const socketClientId = options.socketClientId || null;

    logger.debug('Deleting completely', paths);

    await this.deleteCompletelyOperation(ids, paths);

    if (socketClientId != null) {
      this.pageEvent.emit('deleteCompletely', pages, user, socketClientId); // update as renamed page
    }
    return;
  }

  async deleteCompletely(page, user, options = {}, isRecursively = false) {
    const ids = [page._id];
    const paths = [page.path];
    const socketClientId = options.socketClientId || null;

    logger.debug('Deleting completely', paths);

    await this.deleteCompletelyOperation(ids, paths);

    if (isRecursively) {
      this.deleteCompletelyDescendantsWithStream(page, user, options);
    }

    if (socketClientId != null) {
      this.pageEvent.emit('delete', page, user, socketClientId); // update as renamed page
    }
    return;
  }

  /**
   * Create delete completely stream
   */
  async deleteCompletelyDescendantsWithStream(targetPage, user, options = {}) {
    const Page = this.crowi.model('Page');
    const { PageQueryBuilder } = Page;

    const readStream = new PageQueryBuilder(Page.find())
      .addConditionToExcludeRedirect()
      .addConditionToListOnlyDescendants(targetPage.path)
      .addConditionToFilteringByViewer(user)
      .query
      .lean()
      .cursor();

    const deleteMultipleCompletely = this.deleteMultipleCompletely.bind(this);
    let count = 0;
    const writeStream = new Writable({
      objectMode: true,
      async write(batch, encoding, callback) {
        try {
          count += batch.length;
          await deleteMultipleCompletely(batch, user, options);
          logger.debug(`Adding pages progressing: (count=${count})`);
        }
        catch (err) {
          logger.error('addAllPages error on add anyway: ', err);
        }

        callback();
      },
      final(callback) {
        logger.debug(`Adding pages has completed: (totalCount=${count})`);

        callback();
      },
    });

    readStream
      .pipe(createBatchStream(BULK_REINDEX_SIZE))
      .pipe(writeStream);
  }

  async revertDeletedPages(pages, user) {
    const Page = this.crowi.model('Page');
    const pageCollection = mongoose.connection.collection('pages');
    const revisionCollection = mongoose.connection.collection('revisions');

    const removePageBulkOp = pageCollection.initializeUnorderedBulkOp();
    const revertPageBulkOp = pageCollection.initializeUnorderedBulkOp();
    const revertRevisionBulkOp = revisionCollection.initializeUnorderedBulkOp();

    // e.g. key: '/test'
    const pathToPageMapping = {};
    const toPaths = pages.map(page => Page.getRevertDeletedPageName(page.path));
    const toPages = await Page.find({ path: { $in: toPaths } });
    toPages.forEach((toPage) => {
      pathToPageMapping[toPage.path] = toPage;
    });

    pages.forEach((page) => {

      // e.g. page.path = /trash/test, toPath = /test
      const toPath = Page.getRevertDeletedPageName(page.path);

      if (pathToPageMapping[toPath] != null) {
      // When the page is deleted, it will always be created with "redirectTo" in the path of the original page.
      // So, it's ok to delete the page
      // However, If a page exists that is not "redirectTo", something is wrong. (Data correction is needed).
        if (pathToPageMapping[toPath].redirectTo === page.path) {
          removePageBulkOp.find({ path: toPath }).remove();
        }
      }
      revertPageBulkOp.find({ _id: page._id }).update({ $set: { path: toPath, status: Page.STATUS_PUBLISHED, lastUpdateUser: user._id } });
      revertRevisionBulkOp.find({ path: page.path }).update({ $set: { path: toPath } }, { multi: true });
    });

    try {
      await removePageBulkOp.execute();
      await revertPageBulkOp.execute();
      await revertRevisionBulkOp.execute();
    }
    catch (err) {
      if (err.code !== 11000) {
        throw new Error('Failed to revert pages: ', err);
      }
    }
  }

  async revertDeletedPage(page, user, options = {}, isRecursively = false) {
    const Page = this.crowi.model('Page');
    const newPath = Page.getRevertDeletedPageName(page.path);
    const originPage = await Page.findByPath(newPath);
    if (originPage != null) {
      // When the page is deleted, it will always be created with "redirectTo" in the path of the original page.
      // So, it's ok to delete the page
      // However, If a page exists that is not "redirectTo", something is wrong. (Data correction is needed).
      if (originPage.redirectTo !== page.path) {
        throw new Error('The new page of to revert is exists and the redirect path of the page is not the deleted page.');
      }
      await this.deleteCompletely(originPage, options);
    }

    if (isRecursively) {
      this.revertDeletedDescendantsWithStream(page, user, options);
    }

    page.status = Page.STATUS_PUBLISHED;
    page.lastUpdateUser = user;
    debug('Revert deleted the page', page, newPath);
    const updatedPage = await Page.rename(page, newPath, user, {});
    return updatedPage;
  }

  /**
   * Create revert stream
   */
  async revertDeletedDescendantsWithStream(targetPage, user, options = {}) {
    const Page = this.crowi.model('Page');
    const { PageQueryBuilder } = Page;

    const readStream = new PageQueryBuilder(Page.find())
      .addConditionToExcludeRedirect()
      .addConditionToListOnlyDescendants(targetPage.path)
      .addConditionToFilteringByViewer(user)
      .query
      .lean()
      .cursor();

    const revertDeletedPages = this.revertDeletedPages.bind(this);
    let count = 0;
    const writeStream = new Writable({
      objectMode: true,
      async write(batch, encoding, callback) {
        try {
          count += batch.length;
          revertDeletedPages(batch, user);
          logger.debug(`Reverting pages progressing: (count=${count})`);
        }
        catch (err) {
          logger.error('revertPages error on add anyway: ', err);
        }

        callback();
      },
      final(callback) {
        logger.debug(`Reverting pages has completed: (totalCount=${count})`);

        callback();
      },
    });

    readStream
      .pipe(createBatchStream(BULK_REINDEX_SIZE))
      .pipe(writeStream);
  }


  async handlePrivatePagesForDeletedGroup(deletedGroup, action, transferToUserGroupId) {
    const Page = this.crowi.model('Page');
    const pages = await Page.find({ grantedGroup: deletedGroup });

    switch (action) {
      case 'public':
        await Promise.all(pages.map((page) => {
          return Page.publicizePage(page);
        }));
        break;
      case 'delete':
        return this.deleteMultiplePagesCompletely(pages);
      case 'transfer':
        await Promise.all(pages.map((page) => {
          return Page.transferPageToGroup(page, transferToUserGroupId);
        }));
        break;
      default:
        throw new Error('Unknown action for private pages');
    }
  }

  validateCrowi() {
    if (this.crowi == null) {
      throw new Error('"crowi" is null. Init User model with "crowi" argument first.');
    }
  }

}

module.exports = PageService;
