Meteor.publishComposite = function(name, options) {
    return Meteor.publish(name, function() {
        var subscription = new Subscription(this),
            instanceOptions = options,
            args = Array.prototype.slice.apply(arguments);

        if (typeof instanceOptions === "function") {
            instanceOptions = instanceOptions.apply(this, args);
        }

        var pub = new Publication(subscription, instanceOptions);
        pub.publish();

        this.onStop(function() {
            pub.unpublish();
        });

        this.ready();
    });
};


var Subscription = function(meteorSub) {
    var self = this;
    this.meteorSub = meteorSub;
    this.docHash = {};
    this.refCounter = new DocumentRefCounter({
        onChange: function(collectionName, docId, refCount) {
            debugLog("Subscription.refCounter.onChange", collectionName + ":" + docId.valueOf() + " " + refCount);
            if (refCount <= 0) {
                meteorSub.removed(collectionName, docId);
                self._removeDocHash(docId);
            }
        }
    });
};

Subscription.prototype.added = function(collectionName, doc) {
    this.refCounter.increment(collectionName, doc._id);

    if (this._hasDocChanged(doc._id, doc)) {
        debugLog("Subscription.added", collectionName + ":" + doc._id);
        this.meteorSub.added(collectionName, doc._id, doc);
        this._addDocHash(doc);
    }
};

Subscription.prototype.changed = function(collectionName, id, changes) {
    if (this._hasDocChanged(id, changes)) {
        debugLog("Subscription.changed", collectionName + ":" + id);
        this.meteorSub.changed(collectionName, id, changes);
        this._updateDocHash(id, changes);
    }
};

Subscription.prototype.removed = function(collectionName, docId) {
    debugLog("Subscription.removed", collectionName + ":" + docId.valueOf());
    this.refCounter.decrement(collectionName, docId);
};

Subscription.prototype._addDocHash = function(doc) {
    this.docHash[doc._id.valueOf()] = doc;
};

Subscription.prototype._updateDocHash = function(id, changes) {
    var key = id.valueOf();
    var existingDoc = this.docHash[key] || {};
    this.docHash[key] = _.extend(existingDoc, changes);
};

Subscription.prototype._hasDocChanged = function(id, doc) {
    var existingDoc = this.docHash[id.valueOf()];

    if (!existingDoc) { return true; }

    for (var i in doc) {
        if (doc.hasOwnProperty(i) && !_.isEqual(doc[i], existingDoc[i])) {
            return true;
        }
    }

    return false;
};

Subscription.prototype._removeDocHash = function(docId) {
    delete this.docHash[docId.valueOf()];
};



var Publication = function(subscription, options, args) {
    this.subscription = subscription;
    this.options = options;
    this.args = args || [];
    this.children = options.children || [];
    this.childPublications = [];
    this.collectionName = options.collectionName;
};

Publication.prototype.publish = function() {
    this.cursor = this._getCursor();

    if (!this.cursor) { return; }

    var collectionName = this._getCollectionName();
    var self = this;

    this.observeHandle = this.cursor.observe({
        added: function(doc) {
            var alreadyPublished = !!self.childPublications[doc._id];

            if (alreadyPublished) {
                debugLog("Publication.observeHandle.added", collectionName + ":" + doc._id + " already published");
                self.subscription.changed(collectionName, doc._id, doc);
                self._republishChildrenOf(doc);
            } else {
                self.subscription.added(collectionName, doc);
                self._publishChildrenOf(doc);
            }
        },
        changed: function(newDoc) {
            debugLog("Publication.observeHandle.changed", collectionName + ":" + newDoc._id);
            self._republishChildrenOf(newDoc);
        },
        removed: function(doc) {
            debugLog("Publication.observeHandle.removed", collectionName + ":" + doc._id);
            self._unpublishChildrenOf(doc._id);
            self.subscription.removed(collectionName, doc._id);
        }
    });

    this.observeChangesHandle = this.cursor.observeChanges({
        changed: function(id, fields) {
            debugLog("Publication.observeChangesHandle.changed", collectionName + ":" + id);
            self.subscription.changed(collectionName, id, fields);
        }
    });
};

Publication.prototype.unpublish = function() {
    this._stopObservingCursor();
    this._removeAllCursorDocuments();
    this._unpublishChildPublications();
};

Publication.prototype._republish = function() {
    var collectionName = this._getCollectionName();
    var oldPublishedIds = this._getPublishedIds();

    debugLog("Publication._republish", "stop observing old cursor");
    this._stopObservingCursor();

    debugLog("Publication._republish", "run .publish again");
    this.publish();

    var newPublishedIds = this._getPublishedIds();
    var docsToRemove = _.difference(oldPublishedIds, newPublishedIds);

    debugLog("Publication._republish", "unpublish docs from old cursor, " + JSON.stringify(docsToRemove));
    _.each(docsToRemove, function(docId) {
        this._unpublishChildrenOf(docId);
        this.subscription.removed(collectionName, docId);
    }, this);
};

Publication.prototype._getCursor = function() {
    return this.options.find.apply(this.subscription.meteorSub, this.args);
};

Publication.prototype._getCollectionName = function() {
    return this.collectionName || (this.cursor && this.cursor._getCollectionName());
};

Publication.prototype._publishChildrenOf = function(doc) {
    this.childPublications[doc._id] = [];

    _.each(this.children, function(options) {
        var pub = new Publication(this.subscription, options, [ doc ].concat(this.args));
        this.childPublications[doc._id].push(pub);
        pub.publish();
    }, this);
};

Publication.prototype._republishChildrenOf = function(doc) {
    if (this.childPublications[doc._id]) {
        _.each(this.childPublications[doc._id], function(pub) {
            pub.args[0] = doc;
            pub._republish();
        });
    }
};

Publication.prototype._unpublishChildrenOf = function(docId) {
    docId = docId.valueOf();

    debugLog("Publication._unpublishChildrenOf", "unpublishing children of " + this._getCollectionName() + ":" + docId);
    if (this.childPublications[docId]) {
        _.each(this.childPublications[docId], function(pub) {
            pub.unpublish();
        });
    }
    delete this.childPublications[docId];
};

Publication.prototype._removeAllCursorDocuments = function() {
    if (!this.cursor) { return; }

    var collectionName = this._getCollectionName();

    this.cursor.rewind();
    this.cursor.forEach(function(doc) {
        this.subscription.removed(collectionName, doc._id);
    }, this);
};

Publication.prototype._unpublishChildPublications = function() {
    for (var docId in this.childPublications) {
        this._unpublishChildrenOf(docId);
        delete this.childPublications[docId];
    }
};

Publication.prototype._getPublishedIds = function() {
    if (this.cursor) {
        this.cursor.rewind();
        return this.cursor.map(function(doc) { return doc._id; });
    } else {
        return [];
    }
};

Publication.prototype._stopObservingCursor = function() {
    if (this.observeHandle) {
        this.observeHandle.stop();
        delete this.observeHandle;
    }

    if (this.observeChangesHandle) {
        this.observeChangesHandle.stop();
        delete this.observeChangesHandle;
    }
};


var DocumentRefCounter = function(observer) {
    this.heap = {};
    this.observer = observer;
};

DocumentRefCounter.prototype.increment = function(collectionName, docId) {
    var key = collectionName + ":" + docId.valueOf();
    if (!this.heap[key]) {
        this.heap[key] = 0;
    }
    this.heap[key]++;
};

DocumentRefCounter.prototype.decrement = function(collectionName, docId) {
    var key = collectionName + ":" + docId.valueOf();
    if (this.heap[key]) {
        this.heap[key]--;

        this.observer.onChange(collectionName, docId, this.heap[key]);
    }
};


var enableDebugLogging = false;
var debugLog = enableDebugLogging ? function(source, message) {
    while (source.length < 35) { source += " "; }
    console.log("[" + source + "] " + message);
} : function() { };
