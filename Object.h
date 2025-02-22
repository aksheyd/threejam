#ifndef OBJECT
#define OBJECT

#include <string>

class Object {
	static int _idCounter;
	int _instanceId;

public:
	std::string name;
	// hideFlags

	Object(const std::string& _name) : name(_name), _instanceId(_idCounter++) { }

	int GetInstanceId() {
		return _instanceId;
	}

	std::string ToString() {
		return name;
	}

	static void Destroy(Object obj, float t = 0.0f) {
		// implement later
		return;
	}

	bool operator==(const Object& other) const {
		return _instanceId == other._instanceId;
	}

	bool operator!=(const Object& other) const {
		return !(*this == other);
	}

	/*static bool operator==(const Object& x, const Object& y) {
		return x._instanceId == y._instanceId;
	}*/


};
#endif