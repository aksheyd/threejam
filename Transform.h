#ifndef TRANSFORM_H
#define TRANSFORM_H

#include <iostream>
#include "./Bin/Include/glm/glm.hpp"
#include "./Bin/Include/glm/gtc/type_ptr.hpp"
#include "Component.h"
#include "GameObject.h"
class GameObject;

class Transform : public Component
{
	glm::vec3 _position;
public:
	// FIXME: are transforms trees?
	//Transform* parent;
	//GameObject* gameObject;

	// Construct Transform() with identity coordinates or with an init position
	Transform() : _position(glm::vec3(0.0f, 0.0f, 0.0f)), Component("Transform") { }
	Transform(const glm::vec3& init_position) : _position(init_position), Component("Transform") { }

	void SetPosition(const glm::vec3& new_position) 
	{
		_position = new_position;
	}

	glm::vec3 GetPosition() {
		return _position;
	}
};

#endif
